import { useRef, useState, type PointerEvent } from "react";
import type { ReframePlan } from "@/api/types";
import { containBox, mapRect, type Rect } from "@/lib/crop";
import { clampGroup, fixedWidth } from "@/lib/editing";
import { useElementSize } from "@/lib/useNow";

type Corner = "nw" | "ne" | "sw" | "se";

/**
 * Draggable crop box over the 16:9 source (UI_SPEC 5b Framing). FIXED moves horizontally (full height, 9:16);
 * GROUP moves freely and resizes from its corners with the 9:16 ratio locked. Arrow keys nudge (Shift ×10).
 */
export function CropEditor({
  plan,
  rect,
  mode,
  contentW,
  contentH,
  onChange,
}: {
  plan: ReframePlan;
  rect: Rect;
  mode: "FIXED" | "GROUP";
  contentW?: number;
  contentH?: number;
  onChange: (r: Rect) => void;
}) {
  const [el, setEl] = useState<HTMLDivElement | null>(null);
  const { width, height } = useElementSize(el);
  const box = containBox(width, height, contentW && contentH ? contentW : plan.src_w, contentW && contentH ? contentH : plan.src_h);
  const k = box.w / plan.src_w || 1; // display px per source px
  const d = mapRect(rect, plan.src_w, plan.src_h, box);
  const start = useRef<{ px: number; py: number; r: Rect; corner: Corner | null } | null>(null);

  const apply = (r: Rect) => {
    if (mode === "FIXED") {
      const w = fixedWidth(plan);
      onChange({ x: Math.round(Math.min(plan.src_w - w, Math.max(0, r.x))), y: 0, w, h: plan.src_h });
    } else onChange(clampGroup(plan, r));
  };

  const down = (e: PointerEvent<HTMLElement>, corner: Corner | null) => {
    e.stopPropagation();
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    start.current = { px: e.clientX, py: e.clientY, r: rect, corner };
  };
  const move = (e: PointerEvent<HTMLElement>) => {
    const s = start.current;
    if (!s) return;
    const dx = (e.clientX - s.px) / k;
    const dy = (e.clientY - s.py) / k;
    if (!s.corner) {
      apply({ ...s.r, x: s.r.x + dx, y: mode === "GROUP" ? s.r.y + dy : 0 });
      return;
    }
    // Corner resize, ratio locked to 9:16, anchored at the opposite corner.
    const right = s.corner === "ne" || s.corner === "se";
    const bottom = s.corner === "sw" || s.corner === "se";
    const dh = Math.max(right ? (dx * 16) / 9 : (-dx * 16) / 9, bottom ? dy : -dy);
    const h = Math.min(plan.src_h, Math.max(plan.src_h * 0.25, s.r.h + dh));
    const w = (h * 9) / 16;
    const x = right ? s.r.x : s.r.x + s.r.w - w;
    const y = bottom ? s.r.y : s.r.y + s.r.h - h;
    apply({ x, y, w, h });
  };
  const up = () => {
    start.current = null;
  };

  const handle = (c: Corner, left: number, top: number) => (
    <span
      key={c}
      role="presentation"
      onPointerDown={(e) => down(e, c)}
      onPointerMove={move}
      onPointerUp={up}
      className="absolute size-3 rounded-[2px] border border-accent-ink bg-accent"
      style={{ left: left - 6, top: top - 6, cursor: c === "nw" || c === "se" ? "nwse-resize" : "nesw-resize" }}
    />
  );

  return (
    <div ref={setEl} className="absolute inset-0">
      {width > 0 ? (
        <>
          <div
            role="slider"
            tabIndex={0}
            aria-label={mode === "FIXED" ? "Fixed crop position (arrow keys move it)" : "Group crop box (arrow keys move it)"}
            aria-valuemin={0}
            aria-valuemax={plan.src_w}
            aria-valuenow={Math.round(rect.x)}
            onKeyDown={(e) => {
              const step = e.shiftKey ? 40 : 4;
              const m: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
              const v = m[e.key];
              if (!v) return;
              e.preventDefault();
              e.stopPropagation();
              apply({ ...rect, x: rect.x + v[0], y: mode === "GROUP" ? rect.y + v[1] : 0 });
            }}
            onPointerDown={(e) => down(e, null)}
            onPointerMove={move}
            onPointerUp={up}
            className="absolute cursor-move border-2 border-accent focus-visible:outline-offset-2"
            style={{ left: d.x, top: d.y, width: d.w, height: d.h, touchAction: "none" }}
          />
          {mode === "GROUP" ? [handle("nw", d.x, d.y), handle("ne", d.x + d.w, d.y), handle("sw", d.x, d.y + d.h), handle("se", d.x + d.w, d.y + d.h)] : null}
        </>
      ) : null}
    </div>
  );
}
