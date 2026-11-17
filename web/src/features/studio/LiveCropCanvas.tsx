import { useEffect, useRef } from "react";
import type { ReframePlan } from "@/api/types";
import type { FrameCrop, Rect } from "@/lib/crop";
import { onEachFrame } from "@/lib/media";

const OUT_W = 540;
const OUT_H = 960;

/** Largest sub-rect of `r` with aspect `a` (w/h), centred: what a cover-scale into that aspect shows. */
function coverRect(r: Rect, a: number): Rect {
  if (r.w / r.h > a) {
    const w = r.h * a;
    return { x: r.x + (r.w - w) / 2, y: r.y, w, h: r.h };
  }
  const h = r.w / a;
  return { x: r.x, y: r.y + (r.h - h) / 2, w: r.w, h };
}

function draw(c: HTMLCanvasElement, video: HTMLVideoElement | null, plan: ReframePlan, crop: FrameCrop) {
  const ctx = c.getContext("2d");
  if (!ctx) return;
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, OUT_W, OUT_H);
  if (!video || video.readyState < 2 || !video.videoWidth) return;
  const k = video.videoWidth / plan.src_w; // proxy copies are smaller than the master
  const sc = (r: Rect): Rect => ({ x: r.x * k, y: r.y * k, w: r.w * k, h: r.h * k });
  try {
    if (crop.layout === "SPLIT" && crop.rects.length >= 2) {
      const half = OUT_H / 2;
      [crop.rects[0], crop.rects[1]].forEach((r, i) => {
        const s = sc(coverRect(r, OUT_W / half));
        ctx.drawImage(video, s.x, s.y, s.w, s.h, 0, i * half, OUT_W, half);
      });
      ctx.fillStyle = "rgba(0,0,0,0.6)";
      ctx.fillRect(0, half - 1, OUT_W, 2);
    } else if (crop.layout === "FIT" || !crop.rects.length) {
      const h = (OUT_W * plan.src_h) / plan.src_w;
      ctx.drawImage(video, 0, 0, video.videoWidth, video.videoHeight, 0, (OUT_H - h) / 2, OUT_W, h);
    } else {
      const s = sc(coverRect(crop.rects[0], OUT_W / OUT_H));
      ctx.drawImage(video, s.x, s.y, s.w, s.h, 0, 0, OUT_W, OUT_H);
    }
  } catch {
    /* the frame may not be decodable yet */
  }
}

/**
 * Draws the 9:16 output straight from the source <video> using the reframe plan (no captions, no encode):
 * a live check of what the plan does before anything is rendered. Redraws on every presented source frame
 * and whenever the crop changes (e.g. while dragging the box in the editor).
 */
export function LiveCropCanvas({ video, plan, crop, frameKey }: { video: HTMLVideoElement | null; plan: ReframePlan; crop: FrameCrop; frameKey: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const latest = useRef({ plan, crop });
  latest.current = { plan, crop };

  useEffect(() => {
    if (ref.current) draw(ref.current, video, plan, crop);
  }, [video, plan, crop, frameKey]);

  useEffect(() => {
    if (!video) return;
    return onEachFrame(video, () => {
      if (ref.current) draw(ref.current, video, latest.current.plan, latest.current.crop);
    });
  }, [video]);

  return <canvas ref={ref} width={OUT_W} height={OUT_H} className="absolute inset-0 size-full object-contain" aria-label="Live crop preview drawn from the reframe plan" role="img" />;
}
