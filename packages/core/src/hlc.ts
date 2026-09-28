// Hybrid logical clock, see docs/specs/sync-protocol-spec.md §3.
// Format: <wallMs 13 digits>-<counter 4 digits>-<nodeId 8 hex>, compared lexicographically.

export interface HlcTimestamp {
  wall: number;
  counter: number;
  node: string;
}

const MAX_COUNTER = 9999;
const HLC_RE = /^(\d{13})-(\d{4})-([0-9a-f]{8})$/;

export function nodeIdFromDevice(deviceId: string): string {
  const hex = deviceId.replace(/-/g, "").toLowerCase();
  return (hex + "00000000").slice(0, 8);
}

export function formatHlc(ts: HlcTimestamp): string {
  return `${String(ts.wall).padStart(13, "0")}-${String(ts.counter).padStart(4, "0")}-${ts.node}`;
}

export function parseHlc(value: string): HlcTimestamp {
  const match = HLC_RE.exec(value);
  if (!match) throw new Error(`invalid hlc: ${value}`);
  return { wall: Number(match[1]), counter: Number(match[2]), node: match[3]! };
}

export function isValidHlc(value: string): boolean {
  return HLC_RE.test(value);
}

export function compareHlc(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** HLC for legacy rows that predate the clock. */
export function legacyHlc(date: Date | string | number): string {
  const ms = new Date(date).getTime();
  return formatHlc({ wall: Number.isFinite(ms) ? ms : 0, counter: 0, node: "00000000" });
}

function normalize(ts: HlcTimestamp): HlcTimestamp {
  if (ts.counter > MAX_COUNTER) return { wall: ts.wall + 1, counter: 0, node: ts.node };
  return ts;
}

export class HybridClock {
  private last: HlcTimestamp;

  constructor(
    private readonly node: string,
    initial?: string | null,
    private readonly now: () => number = Date.now,
  ) {
    this.last = initial ? parseHlc(initial) : { wall: 0, counter: 0, node };
  }

  /** Timestamp for a local change. */
  tick(): string {
    const pt = this.now();
    const next =
      pt > this.last.wall
        ? { wall: pt, counter: 0, node: this.node }
        : { wall: this.last.wall, counter: this.last.counter + 1, node: this.node };
    this.last = normalize(next);
    return formatHlc(this.last);
  }

  /** Advance past a remote timestamp. */
  receive(remote: string): string {
    const r = parseHlc(remote);
    const pt = this.now();
    const wall = Math.max(this.last.wall, r.wall, pt);
    let counter: number;
    if (wall === this.last.wall && wall === r.wall) counter = Math.max(this.last.counter, r.counter) + 1;
    else if (wall === this.last.wall) counter = this.last.counter + 1;
    else if (wall === r.wall) counter = r.counter + 1;
    else counter = 0;
    this.last = normalize({ wall, counter, node: this.node });
    return formatHlc(this.last);
  }

  current(): string {
    return formatHlc(this.last);
  }
}
