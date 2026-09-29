//! Hybrid logical clock (sync-protocol-spec §3), byte-for-byte compatible with
//! `packages/core/src/hlc.ts`.
//!
//! Format: `<wallMs 13 digits>-<counter 4 digits>-<nodeId 8 lowercase hex>`, compared as
//! plain strings.

use std::cmp::Ordering;

pub const MAX_COUNTER: u32 = 9999;
/// Remote HLCs more than 24 h ahead of the local clock are rejected (spec §3).
pub const MAX_CLOCK_SKEW_MS: i64 = 24 * 60 * 60 * 1000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HlcTimestamp {
    pub wall: i64,
    pub counter: u32,
    pub node: String,
}

/// `nodeId` = device id without dashes, lowercased, first 8 chars (right-padded with `0`).
pub fn node_id_from_device(device_id: &str) -> String {
    let hex: String = device_id.replace('-', "").to_lowercase();
    let padded = format!("{hex}00000000");
    padded.chars().take(8).collect()
}

/// Node id for the clock: the device-derived id when it is valid hex, otherwise an FNV-1a hash
/// of the device id (mirrors `hexNode` in packages/client/src/sync/engine.ts).
pub fn hex_node(device_id: &str) -> String {
    let node = node_id_from_device(device_id);
    if node.len() == 8
        && node
            .chars()
            .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase())
    {
        return node;
    }
    // FNV-1a over UTF-16 code units, like `charCodeAt` in the TS reference.
    let mut h: u32 = 0x811c9dc5;
    for unit in device_id.encode_utf16() {
        h ^= unit as u32;
        h = h.wrapping_mul(0x01000193);
    }
    format!("{h:08x}")
}

pub fn format_hlc(ts: &HlcTimestamp) -> String {
    format!("{:013}-{:04}-{}", ts.wall, ts.counter, ts.node)
}

pub fn parse_hlc(value: &str) -> Result<HlcTimestamp, String> {
    let bytes = value.as_bytes();
    let valid = bytes.len() == 13 + 1 + 4 + 1 + 8
        && bytes[..13].iter().all(u8::is_ascii_digit)
        && bytes[13] == b'-'
        && bytes[14..18].iter().all(u8::is_ascii_digit)
        && bytes[18] == b'-'
        && bytes[19..]
            .iter()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(b));
    if !valid {
        return Err(format!("invalid hlc: {value}"));
    }
    Ok(HlcTimestamp {
        wall: value[..13]
            .parse()
            .map_err(|_| format!("invalid hlc: {value}"))?,
        counter: value[14..18]
            .parse()
            .map_err(|_| format!("invalid hlc: {value}"))?,
        node: value[19..].to_string(),
    })
}

pub fn is_valid_hlc(value: &str) -> bool {
    parse_hlc(value).is_ok()
}

pub fn compare_hlc(a: &str, b: &str) -> Ordering {
    a.cmp(b)
}

/// HLC for legacy rows that predate the clock: `<ms>-0000-00000000`.
pub fn legacy_hlc_from_ms(ms: i64) -> String {
    format_hlc(&HlcTimestamp {
        wall: ms.max(0),
        counter: 0,
        node: "00000000".to_string(),
    })
}

/// Legacy HLC from an RFC 3339 timestamp (`updatedAt`, else `createdAt`); unparsable → 0.
pub fn legacy_hlc(date: &str) -> String {
    let ms = chrono::DateTime::parse_from_rfc3339(date)
        .map(|d| d.timestamp_millis())
        .unwrap_or(0);
    legacy_hlc_from_ms(ms)
}

fn normalize(ts: HlcTimestamp) -> HlcTimestamp {
    if ts.counter > MAX_COUNTER {
        HlcTimestamp {
            wall: ts.wall + 1,
            counter: 0,
            node: ts.node,
        }
    } else {
        ts
    }
}

pub fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

pub struct HybridClock {
    node: String,
    last: HlcTimestamp,
    now: Box<dyn Fn() -> i64 + Send + Sync>,
}

impl HybridClock {
    pub fn new(node: &str, initial: Option<&str>) -> Self {
        Self::with_now(node, initial, Box::new(now_ms))
    }

    pub fn with_now(
        node: &str,
        initial: Option<&str>,
        now: Box<dyn Fn() -> i64 + Send + Sync>,
    ) -> Self {
        let last = initial
            .and_then(|s| parse_hlc(s).ok())
            .unwrap_or(HlcTimestamp {
                wall: 0,
                counter: 0,
                node: node.to_string(),
            });
        Self {
            node: node.to_string(),
            last,
            now,
        }
    }

    /// Timestamp for a local change.
    pub fn tick(&mut self) -> String {
        let pt = (self.now)();
        let next = if pt > self.last.wall {
            HlcTimestamp {
                wall: pt,
                counter: 0,
                node: self.node.clone(),
            }
        } else {
            HlcTimestamp {
                wall: self.last.wall,
                counter: self.last.counter + 1,
                node: self.node.clone(),
            }
        };
        self.last = normalize(next);
        format_hlc(&self.last)
    }

    /// Advance past a remote timestamp.
    pub fn receive(&mut self, remote: &str) -> Result<String, String> {
        let r = parse_hlc(remote)?;
        let pt = (self.now)();
        let wall = self.last.wall.max(r.wall).max(pt);
        let counter = if wall == self.last.wall && wall == r.wall {
            self.last.counter.max(r.counter) + 1
        } else if wall == self.last.wall {
            self.last.counter + 1
        } else if wall == r.wall {
            r.counter + 1
        } else {
            0
        };
        self.last = normalize(HlcTimestamp {
            wall,
            counter,
            node: self.node.clone(),
        });
        Ok(format_hlc(&self.last))
    }

    pub fn current(&self) -> String {
        format_hlc(&self.last)
    }

    pub fn now(&self) -> i64 {
        (self.now)()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicI64, Ordering as AtomicOrdering};
    use std::sync::Arc;

    fn clock(node: &str, initial: Option<&str>, t: Arc<AtomicI64>) -> HybridClock {
        HybridClock::with_now(
            node,
            initial,
            Box::new(move || t.load(AtomicOrdering::SeqCst)),
        )
    }

    #[test]
    fn formats_like_the_ts_reference() {
        let ts = HlcTimestamp {
            wall: 1727500000123,
            counter: 1,
            node: "a1b2c3d4".into(),
        };
        assert_eq!(format_hlc(&ts), "1727500000123-0001-a1b2c3d4");
        let small = HlcTimestamp {
            wall: 42,
            counter: 7,
            node: "00000000".into(),
        };
        assert_eq!(format_hlc(&small), "0000000000042-0007-00000000");
        assert_eq!(parse_hlc("1727500000123-0001-a1b2c3d4").unwrap(), ts);
    }

    #[test]
    fn rejects_malformed() {
        for bad in [
            "",
            "1727500000123-1-a1b2c3d4",
            "1727500000123-0001-A1B2C3D4",
            "172750000012-0001-a1b2c3d4",
            "1727500000123-0001-a1b2c3d",
            "1727500000123_0001_a1b2c3d4",
        ] {
            assert!(!is_valid_hlc(bad), "{bad}");
        }
    }

    #[test]
    fn node_ids() {
        assert_eq!(
            node_id_from_device("D7F1A2B3-0000-4000-8000-000000000000"),
            "d7f1a2b3"
        );
        assert_eq!(node_id_from_device("ab"), "ab000000");
        assert_eq!(hex_node("d7f1a2b3-0000"), "d7f1a2b3");
        // Non-hex device ids hash deterministically (FNV-1a).
        let h = hex_node("d-remote");
        assert_eq!(h.len(), 8);
        assert_eq!(h, hex_node("d-remote"));
        assert_eq!(hex_node(""), "00000000");
    }

    #[test]
    fn tick_advances_with_wall_clock_and_counter() {
        let t = Arc::new(AtomicI64::new(1000));
        let mut c = clock("aaaaaaaa", None, t.clone());
        assert_eq!(c.tick(), "0000000001000-0000-aaaaaaaa");
        assert_eq!(c.tick(), "0000000001000-0001-aaaaaaaa");
        t.store(999, AtomicOrdering::SeqCst); // clock went backwards
        assert_eq!(c.tick(), "0000000001000-0002-aaaaaaaa");
        t.store(2000, AtomicOrdering::SeqCst);
        assert_eq!(c.tick(), "0000000002000-0000-aaaaaaaa");
    }

    #[test]
    fn counter_overflow_bumps_wall() {
        let t = Arc::new(AtomicI64::new(5));
        let mut c = clock("aaaaaaaa", Some("0000000000010-9999-aaaaaaaa"), t);
        assert_eq!(c.tick(), "0000000000011-0000-aaaaaaaa");
    }

    #[test]
    fn receive_follows_spec_cases() {
        let t = Arc::new(AtomicI64::new(1000));
        let mut c = clock("aaaaaaaa", Some("0000000001000-0003-aaaaaaaa"), t.clone());
        // all equal walls → max(counter)+1
        assert_eq!(
            c.receive("0000000001000-0007-bbbbbbbb").unwrap(),
            "0000000001000-0008-aaaaaaaa"
        );
        // remote ahead
        assert_eq!(
            c.receive("0000000005000-0002-bbbbbbbb").unwrap(),
            "0000000005000-0003-aaaaaaaa"
        );
        // local ahead
        assert_eq!(
            c.receive("0000000001000-0009-bbbbbbbb").unwrap(),
            "0000000005000-0004-aaaaaaaa"
        );
        // physical time ahead
        t.store(9000, AtomicOrdering::SeqCst);
        assert_eq!(
            c.receive("0000000001000-0009-bbbbbbbb").unwrap(),
            "0000000009000-0000-aaaaaaaa"
        );
        assert!(c.receive("garbage").is_err());
    }

    #[test]
    fn legacy() {
        assert_eq!(
            legacy_hlc("2026-09-28T00:00:00Z"),
            "1790553600000-0000-00000000"
        );
        assert_eq!(legacy_hlc("nope"), "0000000000000-0000-00000000");
        assert!(compare_hlc("1727500001000-0000-aaaaaaaa", "1727500001000-0000-bbbbbbbb").is_lt());
    }
}
