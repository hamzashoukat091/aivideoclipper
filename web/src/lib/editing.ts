/** Pure helpers for the clip editor (UI_SPEC 5b): effective framing with draft edits, snapping, shot keys. */
import type { EditContext, Edits, ReframePlan, Shot, ShotEdit } from "@/api/types";
import { cropForFrame, rawFrame, type FrameCrop, type Rect } from "./crop";

export type EditLayout = ShotEdit["layout"];

/** The server keeps the untouched automatic shots in the plan as `auto_shots` (5b apply rules). */
export function autoShots(plan: ReframePlan): Shot[] {
  const extra = plan as ReframePlan & { auto_shots?: unknown };
  return Array.isArray(extra.auto_shots) ? (extra.auto_shots as Shot[]) : plan.shots;
}

export function planFps(plan: ReframePlan): number {
  return plan.frames / Math.max(1e-6, plan.duration);
}

/** Source-time range of shot k. */
export function shotRange(plan: ReframePlan, s: Shot): [number, number] {
  const fps = planFps(plan);
  return [plan.cut_in + s.f0 / fps, plan.cut_in + s.f1 / fps];
}

export function editForShot(plan: ReframePlan, s: Shot, shots: ShotEdit[]): ShotEdit | null {
  const [a, b] = shotRange(plan, s);
  return shots.find((e) => e.at >= a && e.at < b) ?? null;
}

/** Stable key time for a shot edit: the shot midpoint, kept inside the (trimmed) clip. */
export function shotKeyTime(plan: ReframePlan, s: Shot, clipIn: number, clipOut: number): number {
  const [a, b] = shotRange(plan, s);
  const lo = Math.max(a, clipIn) + 0.01;
  const hi = Math.min(b, clipOut) - 0.01;
  const mid = (a + b) / 2;
  return lo <= hi ? Math.min(hi, Math.max(lo, mid)) : mid;
}

export function fixedWidth(plan: ReframePlan): number {
  return Math.round((plan.src_h * 9) / 16);
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export function clampGroup(plan: ReframePlan, r: Rect): Rect {
  const h = clamp(r.h, plan.src_h * 0.25, plan.src_h);
  const w = (h * 9) / 16;
  return { x: clamp(r.x, 0, plan.src_w - w), y: clamp(r.y, 0, plan.src_h - h), w, h };
}

export interface EffectiveCrop extends FrameCrop {
  label: string; // what the viewer sees: "Follow speaker", "Fixed", ...
  edited: boolean;
  held: boolean;
  outside: boolean; // source time not covered by the reframe plan
}

export const LAYOUT_LABEL: Record<EditLayout, string> = {
  AUTO: "Auto",
  TRACK: "Follow speaker",
  FIXED: "Fixed",
  GROUP: "Group",
  SPLIT: "Split",
  FIT: "Full frame",
};

const AUTO_LABEL: Record<Shot["layout"], string> = { TRACK: "Follow speaker", GROUP: "Group", SPLIT: "Split", FIT: "Full frame" };

/**
 * Framing at a source time with the draft shot edits applied on top of the automatic shots, mirroring the
 * server's apply rules (FIXED → constant-x TRACK window, GROUP → crop, FIT → whole frame, SPLIT/TRACK/AUTO → auto).
 * `frameOverride` picks the frame by clip time (held-frame shots show another source frame with their own framing).
 */
export function effectiveCrop(plan: ReframePlan, shots: ShotEdit[], sourceTime: number, opts: { frame?: number; presented?: boolean } = {}): EffectiveCrop {
  const fps = planFps(plan);
  const frameOverride = opts.frame;
  const raw = frameOverride ?? rawFrame(sourceTime, plan.cut_in, fps, !!opts.presented);
  // half a frame of tolerance: decoders report the presented frame's time, which can sit just before cut_in
  const outside = frameOverride === undefined && (sourceTime < plan.cut_in - 0.5 / fps || sourceTime >= plan.cut_in + (plan.frames + 0.5) / fps);
  const f = clamp(raw, 0, plan.frames - 1);
  const auto = autoShots(plan);
  const base = cropForFrame({ ...plan, shots: auto }, f);
  const s = base.shot;
  const held = !outside && !!s && s.hold_frame !== undefined && s.hold_frame !== null;
  const e = s ? editForShot(plan, s, shots) : null;
  const result = (patch: Partial<EffectiveCrop>): EffectiveCrop => ({
    ...base,
    label: base.layout ? AUTO_LABEL[base.layout] : "",
    edited: false,
    held,
    outside,
    ...patch,
  });
  if (!e || e.layout === "AUTO" || e.layout === "TRACK" || e.layout === "SPLIT") {
    return result({ edited: !!e && e.layout !== "AUTO", label: e && e.layout !== "AUTO" ? LAYOUT_LABEL[e.layout] : base.layout ? AUTO_LABEL[base.layout] : "" });
  }
  if (e.layout === "FIT") return result({ layout: "FIT", rects: [{ x: 0, y: 0, w: plan.src_w, h: plan.src_h, label: "fit" }], edited: true, label: "Full frame" });
  if (e.layout === "FIXED") {
    const w = fixedWidth(plan);
    return result({ layout: "TRACK", rects: [{ x: clamp(e.x ?? (plan.src_w - w) / 2, 0, plan.src_w - w), y: 0, w, h: plan.src_h, label: "fixed" }], edited: true, label: "Fixed" });
  }
  const c = e.crop ? clampGroup(plan, e.crop) : clampGroup(plan, { x: 0, y: 0, w: (plan.src_h * 9) / 16, h: plan.src_h });
  return result({ layout: "GROUP", rects: [{ ...c, label: "group" }], edited: true, label: "Group" });
}

/** A sensible starting crop when the user switches a shot to FIXED or GROUP. */
export function seedShotEdit(plan: ReframePlan, layout: EditLayout, at: number, current: FrameCrop): ShotEdit {
  const r = current.rects[0] ?? { x: 0, y: 0, w: plan.src_w, h: plan.src_h };
  const cx = r.x + r.w / 2;
  const cy = r.y + r.h / 2;
  if (layout === "FIXED") {
    const w = fixedWidth(plan);
    return { at, layout, x: Math.round(clamp(cx - w / 2, 0, plan.src_w - w)) };
  }
  if (layout === "GROUP") {
    const h = Math.min(plan.src_h, Math.max(r.h, plan.src_h * 0.85));
    const w = (h * 9) / 16;
    const c = clampGroup(plan, { x: cx - w / 2, y: cy - h / 2, w, h });
    return { at, layout, crop: { x: Math.round(c.x), y: Math.round(c.y), w: Math.round(c.w * 1000) / 1000, h: Math.round(c.h) } };
  }
  return { at, layout };
}

// ---------------------------------------------------------------- trim / snapping

export type CtxWord = EditContext["words"][number];

/** Snap points = middles of the gaps between consecutive words (plus the outer word edges). */
export function snapPoints(words: CtxWord[]): number[] {
  const pts: number[] = [];
  for (let k = 0; k < words.length; k += 1) {
    const w = words[k];
    const prev = words[k - 1];
    if (!prev) pts.push(w.start);
    else pts.push(prev.end <= w.start ? (prev.end + w.start) / 2 : w.start);
    if (k === words.length - 1) pts.push(w.end);
  }
  return pts;
}

export function snap(t: number, pts: number[], within = 0.35): number {
  let best = t;
  let d = within;
  for (const p of pts) {
    const dd = Math.abs(p - t);
    if (dd < d) {
      d = dd;
      best = p;
    }
  }
  return best;
}

export function stepWord(t: number, pts: number[], dir: 1 | -1): number {
  if (dir > 0) return pts.find((p) => p > t + 1e-3) ?? t;
  for (let k = pts.length - 1; k >= 0; k -= 1) if (pts[k] < t - 1e-3) return pts[k];
  return t;
}

export function clipRange(ctx: EditContext, e: Edits): { cutIn: number; cutOut: number } {
  return { cutIn: e.trim?.cut_in ?? ctx.original.cut_in, cutOut: e.trim?.cut_out ?? ctx.original.cut_out };
}

export function sameEdits(a: Edits, b: Edits): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function defaultEdits(ctx: EditContext): Edits {
  return {
    version: 1,
    trim: null,
    shots: [],
    words: {},
    hook: { text: ctx.original.hook, enabled: true, seconds: 3 },
    captions: { enabled: true, position: "auto", size: 84 },
    title: null,
  };
}
