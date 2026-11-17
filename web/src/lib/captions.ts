import type { CaptionEvent } from "@/api/types";

export interface Chunk {
  start: number;
  end: number;
  text: string;
}

/** Consecutive caption events with the same text are one on-screen chunk (word highlight moves inside it). */
export function captionChunks(events: CaptionEvent[]): Chunk[] {
  const out: Chunk[] = [];
  for (const e of events) {
    if (e.kind !== "caption") continue;
    const last = out[out.length - 1];
    if (last && last.text === e.text && Math.abs(last.end - e.start) < 0.05) last.end = e.end;
    else out.push({ start: e.start, end: e.end, text: e.text });
  }
  return out;
}
