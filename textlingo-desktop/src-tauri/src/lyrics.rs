//! Lyrics import (LRC incl. enhanced word tags, with plain-text fallback). Port of
//! `packages/core/src/lrc.ts` `parseLrc`; times are seconds.

use crate::types::{Article, ArticleSegment};
use regex::Regex;
use std::path::Path;

#[derive(Debug, Clone, Default, PartialEq)]
pub struct LyricsMetaTags {
    pub title: Option<String>,
    pub artist: Option<String>,
    pub album: Option<String>,
    pub by: Option<String>,
    pub length: Option<f64>,
    pub offset_ms: Option<i64>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct LyricLine {
    pub start_time: Option<f64>,
    pub end_time: Option<f64>,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ParsedLyrics {
    /// "lrc" | "txt"
    pub format: String,
    pub meta: LyricsMetaTags,
    pub lines: Vec<LyricLine>,
}

fn clock_seconds(value: &str) -> Option<f64> {
    let parts: Vec<&str> = value.trim().split(':').collect();
    if parts.len() < 2 || parts.len() > 3 {
        return None;
    }
    let mut total = 0.0;
    for p in parts {
        if p.is_empty() {
            return None;
        }
        let n: f64 = p.parse().ok()?;
        if !n.is_finite() || n < 0.0 {
            return None;
        }
        total = total * 60.0 + n;
    }
    Some(total)
}

fn round3(x: f64) -> f64 {
    (x * 1000.0).round() / 1000.0
}

fn apply_meta(meta: &mut LyricsMetaTags, key: &str, value: &str) {
    let v = value.trim().to_string();
    match key.to_lowercase().as_str() {
        "ti" => meta.title = Some(v),
        "ar" => meta.artist = Some(v),
        "al" => meta.album = Some(v),
        "by" => meta.by = Some(v),
        "length" => meta.length = clock_seconds(&v).or(meta.length),
        "offset" => {
            if let Ok(n) = v.trim_start_matches('+').parse::<i64>() {
                meta.offset_ms = Some(n);
            }
        }
        _ => {}
    }
}

pub fn parse_lrc(raw: &str) -> ParsedLyrics {
    let time_tag = Regex::new(r"^\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]").unwrap();
    let meta_tag = Regex::new(r"^\[([a-zA-Z#]+):(.*)\]$").unwrap();
    let word_tag = Regex::new(r"<\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?>").unwrap();
    let spaces = Regex::new(r"\s{2,}").unwrap();

    let normalized = raw
        .trim_start_matches('\u{feff}')
        .replace("\r\n", "\n")
        .replace('\r', "\n");
    let mut meta = LyricsMetaTags::default();
    let mut timed: Vec<(f64, String, usize)> = Vec::new();
    let mut untimed: Vec<String> = Vec::new();
    let mut seq = 0usize;

    for raw_line in normalized.split('\n') {
        let line = raw_line.trim();
        if line.is_empty() {
            continue;
        }
        let mut stamps = Vec::new();
        let mut rest = line;
        while let Some(c) = time_tag.captures(rest) {
            let min: f64 = c[1].parse().unwrap_or(0.0);
            let sec: f64 = c[2].parse().unwrap_or(0.0);
            let frac = c
                .get(3)
                .map(|m| {
                    m.as_str().parse::<f64>().unwrap_or(0.0) / 10f64.powi(m.as_str().len() as i32)
                })
                .unwrap_or(0.0);
            stamps.push(min * 60.0 + sec + frac);
            rest = rest[c.get(0).unwrap().end()..].trim_start_matches([' ', '\t']);
        }
        let clean = |s: &str| {
            spaces
                .replace_all(&word_tag.replace_all(s, ""), " ")
                .trim()
                .to_string()
        };
        if stamps.is_empty() {
            if let Some(c) = meta_tag.captures(line) {
                apply_meta(&mut meta, &c[1], &c[2]);
            } else {
                untimed.push(clean(line));
            }
            continue;
        }
        let text = clean(rest);
        for start in stamps {
            timed.push((start, text.clone(), seq));
            seq += 1;
        }
    }

    if timed.is_empty() {
        return ParsedLyrics {
            format: "txt".into(),
            meta,
            lines: untimed
                .into_iter()
                .filter(|t| !t.is_empty())
                .map(|text| LyricLine {
                    start_time: None,
                    end_time: None,
                    text,
                })
                .collect(),
        };
    }

    let shift = meta.offset_ms.unwrap_or(0) as f64 / 1000.0;
    timed.sort_by(|a, b| {
        a.0.partial_cmp(&b.0)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then(a.2.cmp(&b.2))
    });
    let trailing = 5.0;
    let mut lines = Vec::new();
    for (i, (start, text, _)) in timed.iter().enumerate() {
        let start = (start - shift).max(0.0);
        let end = if let Some(next) = timed.get(i + 1) {
            (next.0 - shift).max(start)
        } else if let Some(len) = meta.length.filter(|l| *l > start) {
            len
        } else {
            start + trailing
        };
        if !text.is_empty() {
            lines.push(LyricLine {
                start_time: Some(round3(start)),
                end_time: Some(round3(end)),
                text: text.clone(),
            });
        }
    }
    ParsedLyrics {
        format: "lrc".into(),
        meta,
        lines,
    }
}

/// Build a lyrics article (`source_type = "lyrics"`, one timed segment per line) from an .lrc.
pub fn create_article_from_lrc(
    path: &Path,
    title: Option<String>,
) -> Result<(Article, ParsedLyrics), String> {
    let raw = crate::commands::read_txt_decoded(path)?;
    let parsed = parse_lrc(&raw);
    if parsed.lines.is_empty() {
        return Err("未能从歌词文件中解析到有效歌词".into());
    }
    let id = uuid::Uuid::new_v4().to_string();
    let now = chrono::Utc::now().to_rfc3339();
    let segments: Vec<ArticleSegment> = parsed
        .lines
        .iter()
        .enumerate()
        .map(|(i, l)| ArticleSegment {
            id: uuid::Uuid::new_v4().to_string(),
            article_id: id.clone(),
            order: i as i32,
            text: l.text.clone(),
            reading_text: None,
            translation: None,
            explanation: None,
            start_time: l.start_time,
            end_time: l.end_time,
            created_at: now.clone(),
            is_new_paragraph: true,
        })
        .collect();
    let default_title = parsed
        .meta
        .title
        .clone()
        .filter(|t| !t.is_empty())
        .or_else(|| {
            path.file_stem()
                .and_then(|s| s.to_str())
                .map(str::to_string)
        })
        .unwrap_or_else(|| "lyrics".into());
    let article = Article {
        id,
        title: title
            .filter(|t| !t.trim().is_empty())
            .unwrap_or(default_title),
        content: parsed
            .lines
            .iter()
            .map(|l| l.text.as_str())
            .collect::<Vec<_>>()
            .join("\n"),
        source_type: Some("lyrics".into()),
        source_url: None,
        media_path: None,
        book_path: None,
        book_type: None,
        created_at: now,
        translated: false,
        active_mind_map_artifact_id: None,
        segments,
    };
    Ok((article, parsed))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_lrc_like_the_ts_reference() {
        let raw = "\u{feff}[ti:Song]\n[ar:Singer]\n[offset:+500]\n[00:01.00][00:10.50]Hello <00:01.20>world\n[00:05.000]Second\n[00:07.00]\n";
        let p = parse_lrc(raw);
        assert_eq!(p.format, "lrc");
        assert_eq!(p.meta.title.as_deref(), Some("Song"));
        assert_eq!(p.meta.artist.as_deref(), Some("Singer"));
        assert_eq!(p.meta.offset_ms, Some(500));
        let got: Vec<(Option<f64>, Option<f64>, &str)> = p
            .lines
            .iter()
            .map(|l| (l.start_time, l.end_time, l.text.as_str()))
            .collect();
        assert_eq!(
            got,
            vec![
                (Some(0.5), Some(4.5), "Hello world"),
                (Some(4.5), Some(6.5), "Second"),
                (Some(10.0), Some(15.0), "Hello world"),
            ]
        );
    }

    #[test]
    fn untimed_falls_back_to_text() {
        let p = parse_lrc("line one\n\nline two\n[ar:x]");
        assert_eq!(p.format, "txt");
        assert_eq!(p.lines.len(), 2);
        assert_eq!(p.lines[0].start_time, None);
    }
}
