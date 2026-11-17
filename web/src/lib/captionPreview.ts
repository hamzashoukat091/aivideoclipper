/**
 * Caption preview: a TypeScript port of clipper/captions.py (chunking, timing, positions, colours) so the editor
 * can show the caption look live over the 9:16 view without rendering. Keep in step with captions.py.
 */
import type { Edits, Shot } from "@/api/types";

export const CAP = {
  size: 84,
  hookSize: 62,
  outline: 7,
  activeColor: "#FFE500", // ASS &H00E5FF& is BGR
  hookY: 290,
  hookLineChars: 22,
  yByLayout: { TRACK: 1150, GROUP: 1150, SPLIT: 960, FIT: 520 } as Record<Shot["layout"], number>,
  // clipper/edits.py POSITION_Y
  yByPosition: { upper: 520, middle: 960, lower: 1150 } as const,
};

const MAX_WORDS = 3;
const MAX_CHARS = 14;
const MAX_CHUNK_S = 1.8;
const MIN_CHUNK_S = 0.28;
const PAUSE_BREAK_S = 0.28;
const GAP_HOLD_S = 0.3;
const LEAD_S = 0.03;
const TAIL_S = 0.15;
const FUNCTION_WORDS = new Set(["a", "an", "the", "to", "of", "and", "in", "on", "at", "for", "with", "i", "my", "your", "his", "her", "their", "our", "is", "was", "but", "or", "so", "that", "this", "it's", "i'm", "you"]);
const HARD = /[.?!]["')\]]*$/;
const SOFT = /[,;:—–-]["')\]]*$/;

export interface PWord {
  i: number;
  w: string;
  start: number; // clip-relative
  end: number;
}

export const clean = (w: string) => w.trim().toUpperCase().replace(/\{/g, "(").replace(/\}/g, ")").replace(/\\/g, "/");

function chunk(words: PWord[], maxChars: number): PWord[][] {
  const out: PWord[][] = [];
  let cur: PWord[] = [];
  words.forEach((w, i) => {
    cur.push(w);
    const nxt = i + 1 < words.length ? words[i + 1] : null;
    const text = cur.map((x) => clean(x.w)).join(" ");
    const brk =
      nxt === null ||
      HARD.test(w.w) ||
      SOFT.test(w.w) ||
      nxt.start - w.end > PAUSE_BREAK_S ||
      cur.length >= MAX_WORDS ||
      text.length + 1 + clean(nxt.w).length > maxChars ||
      nxt.end - cur[0].start > MAX_CHUNK_S;
    const softOnly = nxt !== null && !(HARD.test(w.w) || SOFT.test(w.w) || nxt.start - w.end > PAUSE_BREAK_S);
    if (brk && softOnly && FUNCTION_WORDS.has(w.w.toLowerCase().replace(/\W/g, "")) && cur.length > 1) {
      out.push(cur.slice(0, -1));
      cur = [w];
      return;
    }
    if (brk) {
      out.push(cur);
      cur = [];
    }
  });
  if (cur.length) out.push(cur);
  const merged: PWord[][] = [];
  for (const c of out) {
    const last = merged[merged.length - 1];
    if (
      last &&
      c[c.length - 1].end - c[0].start < MIN_CHUNK_S &&
      c[0].start - last[last.length - 1].end < 0.15 &&
      last.length + c.length <= MAX_WORDS &&
      [...last, ...c].map((w) => clean(w.w)).join(" ").length <= maxChars + 4
    ) {
      merged[merged.length - 1] = [...last, ...c];
    } else merged.push(c);
  }
  return merged;
}

export interface CapEvent {
  start: number;
  end: number;
  tokens: string[];
  active: number;
  y: number;
}

/** Caption events exactly as captions.py would time them (one event per spoken word, never two at once). */
export function buildCaptionEvents(words: PWord[], clipDur: number, layoutAt: (t: number) => Shot["layout"] | null, position: Edits["captions"]["position"], size: number = CAP.size): CapEvent[] {
  // captions.py: chunk width scales with the caption size so bigger text still fits the frame
  const maxChars = Math.max(8, Math.round((MAX_CHARS * CAP.size) / size));
  const chunks = chunk(words.filter((w) => w.end > 0 && w.start < clipDur), maxChars);
  const caps: CapEvent[] = [];
  chunks.forEach((c, ci) => {
    const nxt = ci + 1 < chunks.length ? chunks[ci + 1][0].start : null;
    let cEnd = nxt !== null && nxt - c[c.length - 1].end < GAP_HOLD_S ? nxt : c[c.length - 1].end + TAIL_S;
    cEnd = Math.min(cEnd, clipDur);
    const lay = layoutAt((c[0].start + c[c.length - 1].end) / 2);
    const y = position === "auto" ? (lay ? CAP.yByLayout[lay] : 1150) : CAP.yByPosition[position];
    const tokens = c.map((w) => clean(w.w));
    c.forEach((w, k) => {
      const s = k === 0 ? Math.max(0, c[0].start - LEAD_S) : w.start;
      const e = k + 1 < c.length ? c[k + 1].start : cEnd;
      if (e - s >= 0.02) caps.push({ start: s, end: e, tokens, active: k, y });
    });
  });
  caps.sort((a, b) => a.start - b.start);
  for (let k = 0; k + 1 < caps.length; k += 1) caps[k].end = Math.min(caps[k].end, caps[k + 1].start);
  return caps.filter((c) => c.end - c.start >= 0.02);
}

export function wrapHook(text: string, n = CAP.hookLineChars): string[] {
  const lines: string[] = [];
  let cur = "";
  for (const w of clean(text).split(/\s+/).filter(Boolean)) {
    if (cur && cur.length + 1 + w.length > n) {
      lines.push(cur);
      cur = w;
    } else cur = `${cur} ${w}`.trim();
  }
  if (cur) lines.push(cur);
  return lines;
}
