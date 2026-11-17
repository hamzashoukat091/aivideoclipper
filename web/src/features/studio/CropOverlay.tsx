import { useState } from "react";
import type { ReframePlan } from "@/api/types";
import { containBox, LAYOUT_COLOR, mapRect, type FrameCrop } from "@/lib/crop";
import { useElementSize } from "@/lib/useNow";

/**
 * Crop rectangle(s) for the current frame drawn over the 16:9 source (UI_SPEC 5.6). Source pixels (src_w×src_h)
 * are mapped into the displayed content box of the <video> (object-fit: contain, so letterboxing is excluded).
 * `contentW/H` = the video's intrinsic size when known (a 720p proxy keeps the master aspect), else src_w/src_h.
 */
export function CropOverlay({ plan, crop, contentW, contentH, showMask = true }: { plan: ReframePlan; crop: FrameCrop; contentW?: number; contentH?: number; showMask?: boolean }) {
  const [el, setEl] = useState<HTMLDivElement | null>(null);
  const { width, height } = useElementSize(el);
  const cw = contentW && contentH ? contentW : plan.src_w;
  const ch = contentW && contentH ? contentH : plan.src_h;
  const box = containBox(width, height, cw, ch);
  const color = crop.layout ? LAYOUT_COLOR[crop.layout] : "rgb(var(--accent))";
  const rects = crop.rects.map((r) => ({ ...mapRect(r, plan.src_w, plan.src_h, box), label: r.label }));
  const maskPath =
    `M${box.x},${box.y} h${box.w} v${box.h} h${-box.w} Z ` + rects.map((r) => `M${r.x},${r.y} v${r.h} h${r.w} v${-r.h} Z`).join(" ");

  return (
    <div ref={setEl} className="pointer-events-none absolute inset-0" aria-hidden>
      {width > 0 ? (
        <svg width={width} height={height} className="absolute inset-0">
          {showMask && crop.layout !== "FIT" ? <path d={maskPath} fill="black" fillOpacity={0.55} fillRule="evenodd" /> : null}
          {rects.map((r, i) => (
            <g key={i}>
              <rect x={r.x + 1} y={r.y + 1} width={Math.max(0, r.w - 2)} height={Math.max(0, r.h - 2)} fill="none" stroke={color} strokeWidth={2} />
              {/* rule-of-thirds guide inside the crop */}
              <line x1={r.x} x2={r.x + r.w} y1={r.y + r.h / 3} y2={r.y + r.h / 3} stroke="white" strokeOpacity={0.12} />
              <line x1={r.x} x2={r.x + r.w} y1={r.y + (2 * r.h) / 3} y2={r.y + (2 * r.h) / 3} stroke="white" strokeOpacity={0.12} />
              {rects.length > 1 ? (
                <g transform={`translate(${r.x + 4},${r.y + 4})`}>
                  <rect width={r.label.length * 7 + 10} height={16} rx={3} fill={color} />
                  <text x={5} y={12} style={{ fontSize: 11, fontFamily: "Geist Mono, monospace" }} fill="rgb(var(--accent-ink))">
                    {r.label}
                  </text>
                </g>
              ) : null}
            </g>
          ))}
          {box.w > 0 ? <rect x={box.x + 0.5} y={box.y + 0.5} width={Math.max(0, box.w - 1)} height={Math.max(0, box.h - 1)} fill="none" stroke="rgb(var(--line))" /> : null}
        </svg>
      ) : null}
    </div>
  );
}
