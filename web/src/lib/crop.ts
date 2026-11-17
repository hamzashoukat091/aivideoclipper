import type { ReframePlan, Shot } from "@/api/types";

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}
export interface FrameCrop {
  frame: number;
  shot: Shot | null;
  shotIndex: number;
  layout: Shot["layout"] | null;
  rects: (Rect & { label: string })[];
  speakerTrack: number | null;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Plan frame for a source time: floor((t - cut_in) * fps) for a continuous time. */
export function rawFrame(sourceTime: number, cutIn: number, fps: number, presented = false): number {
  const v = (sourceTime - cutIn) * fps;
  // A presented frame's mediaTime is the START of a source frame. Plan frame k is the k-th source frame at or
  // after cut_in, so for presented times the index is ceil (the grid is not aligned to cut_in); floor would show
  // the crop of the previous plan frame for the whole frame.
  return presented ? Math.ceil(v - 1e-3) : Math.floor(v + 1e-6);
}

/** frame index = floor((sourceTime - cut_in) * fps) (ceil for a presented frame's mediaTime), clamped to [0, frames-1]. */
export function frameIndex(sourceTime: number, cutIn: number, fps: number, frames: number, presented = false): number {
  if (!Number.isFinite(sourceTime) || fps <= 0 || frames <= 0) return 0;
  return clamp(rawFrame(sourceTime, cutIn, fps, presented), 0, frames - 1);
}

export function shotIndexAt(plan: ReframePlan, f: number): number {
  const shots = plan.shots;
  for (let i = 0; i < shots.length; i += 1) if (f >= shots[i].f0 && f < shots[i].f1) return i;
  return shots.length ? (f < shots[0].f0 ? 0 : shots.length - 1) : -1;
}

/**
 * Absolute hard-cut frames of a shot. ASSUMPTION (not specified): values inside [f0, f1) are absolute clip
 * frames, smaller values are offsets from f0.
 */
export function hardCutFrames(s: Shot): number[] {
  return (s.hard_cuts ?? []).map((v) => (v >= s.f0 && v < s.f1 ? v : s.f0 + v)).filter((v) => v >= s.f0 && v < s.f1);
}

/** Crop rectangle(s) in SOURCE pixels (src_w × src_h) for frame f, per UI_SPEC 5.6. */
export function cropForFrame(plan: ReframePlan, f: number): FrameCrop {
  const i = shotIndexAt(plan, f);
  if (i < 0) return { frame: f, shot: null, shotIndex: -1, layout: null, rects: [], speakerTrack: null };
  const s = plan.shots[i];
  const k = clamp(f - s.f0, 0, Math.max(0, s.f1 - s.f0 - 1));
  const full: Rect = { x: 0, y: 0, w: plan.src_w, h: plan.src_h };
  const at = <T,>(arr: T[] | undefined): T | null => (arr && arr.length ? arr[Math.min(k, arr.length - 1)] : null);
  let rects: (Rect & { label: string })[] = [];
  switch (s.layout) {
    case "TRACK": {
      const h = s.h ?? s.crop?.h ?? plan.src_h;
      const w = s.w ?? s.crop?.w ?? Math.round((h * 9) / 16);
      const x = at(s.x) ?? s.crop?.x ?? (plan.src_w - w) / 2;
      const y = s.crop?.y ?? (plan.src_h - h) / 2;
      rects = [{ x, y: Math.max(0, y), w, h, label: "crop" }];
      break;
    }
    case "GROUP": {
      if (s.crop) rects = [{ ...s.crop, label: "group" }];
      else if (s.w && s.h) {
        const x = at(s.x) ?? (plan.src_w - s.w) / 2;
        rects = [{ x, y: Math.max(0, (plan.src_h - s.h) / 2), w: s.w, h: s.h, label: "group" }];
      } else rects = [{ ...full, label: "group" }];
      break;
    }
    case "SPLIT": {
      if (s.top) rects.push({ ...s.top, label: "top" });
      if (s.bottom) rects.push({ ...s.bottom, label: "bottom" });
      if (!rects.length) rects = [{ ...full, label: "split" }];
      break;
    }
    case "FIT":
      rects = [{ ...full, label: "fit" }];
      break;
  }
  return { frame: f, shot: s, shotIndex: i, layout: s.layout, rects, speakerTrack: at(s.speaker_track) };
}

/** The displayed content box of a media element with object-fit: contain (letterboxing considered). */
export function containBox(boxW: number, boxH: number, contentW: number, contentH: number): Rect {
  if (boxW <= 0 || boxH <= 0 || contentW <= 0 || contentH <= 0) return { x: 0, y: 0, w: 0, h: 0 };
  const scale = Math.min(boxW / contentW, boxH / contentH);
  const w = contentW * scale;
  const h = contentH * scale;
  return { x: (boxW - w) / 2, y: (boxH - h) / 2, w, h };
}

/** Map a rect in source pixels into the displayed content box. */
export function mapRect(r: Rect, srcW: number, srcH: number, box: Rect): Rect {
  const sx = box.w / srcW;
  const sy = box.h / srcH;
  return { x: box.x + r.x * sx, y: box.y + r.y * sy, w: r.w * sx, h: r.h * sy };
}

export const LAYOUT_COLOR: Record<Shot["layout"], string> = {
  TRACK: "rgb(var(--run))",
  GROUP: "rgb(var(--ok))",
  SPLIT: "rgb(var(--warn))",
  FIT: "rgb(var(--muted))",
};

export const LAYOUT_TEXT: Record<Shot["layout"], string> = {
  TRACK: "Follows one face with a 9:16 window",
  GROUP: "One wider window keeps a group together",
  SPLIT: "Two faces stacked top / bottom",
  FIT: "Whole frame fitted into 9:16",
};
