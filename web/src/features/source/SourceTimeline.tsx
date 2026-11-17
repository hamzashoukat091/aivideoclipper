import { useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import type { Candidate } from "@/api/types";
import { decisionStyle } from "@/lib/decision";
import { fmtClock } from "@/lib/format";
import { useElementSize } from "@/lib/useNow";

const H_CH = 20;
const H_HEAT = 56;
const H_CLIP = 18;
const H_AXIS = 18;
const GAP = 4;
const TOTAL = H_CH + GAP + H_HEAT + GAP + H_CLIP + H_AXIS;

function niceStep(duration: number, width: number): number {
  const target = duration / Math.max(1, width / 90);
  const steps = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600];
  return steps.find((s) => s >= target) ?? 3600;
}

/**
 * Source timeline (UI_SPEC 5.4): chapter bands, the YouTube "Most replayed" heatmap curve, candidate clip
 * ranges coloured by decision, playhead. Click / drag to seek; arrow keys ±5 s (Shift ±30 s).
 */
export function SourceTimeline({
  duration,
  time,
  heatmap,
  chapters,
  clips,
  onSeek,
  onClipClick,
}: {
  duration: number;
  time: number;
  heatmap: { start: number; end: number; value: number }[];
  chapters: { start: number; end: number; title: string }[];
  clips: Candidate[];
  onSeek: (t: number) => void;
  onClipClick?: (c: Candidate) => void;
}) {
  const [el, setEl] = useState<HTMLDivElement | null>(null);
  const { width } = useElementSize(el);
  const [hover, setHover] = useState<number | null>(null);
  const dragging = useRef(false);
  const W = Math.max(1, width);
  const d = Math.max(0.001, duration);
  const x = (t: number) => (t / d) * W;
  const tAt = (px: number) => Math.max(0, Math.min(d, (px / W) * d));

  const heatPath = useMemo(() => {
    if (!heatmap.length) return null;
    const pts = heatmap.map((h) => [((h.start + h.end) / 2 / d) * W, H_HEAT - h.value * (H_HEAT - 4)] as const);
    let line = `M0,${pts[0][1].toFixed(1)} L${pts[0][0].toFixed(1)},${pts[0][1].toFixed(1)}`;
    for (let i = 1; i < pts.length; i += 1) {
      const [px, py] = pts[i];
      const [qx, qy] = pts[i - 1];
      const mx = ((qx + px) / 2).toFixed(1);
      line += ` C${mx},${qy.toFixed(1)} ${mx},${py.toFixed(1)} ${px.toFixed(1)},${py.toFixed(1)}`;
    }
    line += ` L${W},${pts[pts.length - 1][1].toFixed(1)}`;
    return { line, fill: `${line} L${W},${H_HEAT} L0,${H_HEAT} Z` };
  }, [heatmap, d, W]);

  const step = niceStep(d, W);
  const ticks: number[] = [];
  for (let t = 0; t <= d; t += step) ticks.push(t);

  const fromEvent = (e: PointerEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return tAt(e.clientX - r.left);
  };
  const onKey = (e: KeyboardEvent) => {
    const big = e.shiftKey ? 30 : 5;
    if (e.key === "ArrowRight") onSeek(Math.min(d, time + big));
    else if (e.key === "ArrowLeft") onSeek(Math.max(0, time - big));
    else if (e.key === "Home") onSeek(0);
    else if (e.key === "End") onSeek(d);
    else return;
    e.preventDefault();
  };

  const hoverInfo = hover !== null ? { t: hover, ch: chapters.find((c) => hover >= c.start && hover < c.end), heat: heatmap.find((h) => hover >= h.start && hover < h.end) } : null;
  const yHeat = H_CH + GAP;
  const yClip = yHeat + H_HEAT + GAP;
  const yAxis = yClip + H_CLIP;

  return (
    <div ref={setEl} className="relative select-none">
      <svg
        width={W}
        height={TOTAL}
        role="slider"
        tabIndex={0}
        aria-label="Source timeline"
        aria-valuemin={0}
        aria-valuemax={Math.round(d)}
        aria-valuenow={Math.round(time)}
        aria-valuetext={fmtClock(time)}
        onKeyDown={onKey}
        className="block cursor-pointer rounded focus-visible:outline-offset-4"
        onPointerDown={(e) => {
          dragging.current = true;
          e.currentTarget.setPointerCapture(e.pointerId);
          onSeek(fromEvent(e));
        }}
        onPointerMove={(e) => {
          const t = fromEvent(e);
          setHover(t);
          if (dragging.current) onSeek(t);
        }}
        onPointerUp={() => {
          dragging.current = false;
        }}
        onPointerLeave={() => setHover(null)}
      >
        <defs>
          <linearGradient id="heatfill" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="rgb(var(--accent))" stopOpacity="0.45" />
            <stop offset="100%" stopColor="rgb(var(--accent))" stopOpacity="0.04" />
          </linearGradient>
        </defs>
        {/* chapters */}
        {chapters.map((c, i) => {
          const x0 = x(c.start);
          const w = Math.max(1, x(Math.min(c.end, d)) - x0);
          return (
            <g key={i}>
              <rect x={x0 + 0.5} y={0} width={Math.max(0, w - 1)} height={H_CH} rx={3} fill={i % 2 ? "rgb(var(--raised))" : "rgb(var(--panel-2))"} stroke="rgb(var(--line))" />
              {w > 60 ? (
                <foreignObject x={x0 + 6} y={0} width={w - 12} height={H_CH} pointerEvents="none">
                  <div className="truncate text-xs leading-5 text-muted">{c.title}</div>
                </foreignObject>
              ) : null}
            </g>
          );
        })}
        {!chapters.length ? (
          <text x={6} y={14} className="fill-faint text-xs">
            No chapters
          </text>
        ) : null}
        {/* heatmap */}
        <g transform={`translate(0,${yHeat})`}>
          <rect x={0} y={0} width={W} height={H_HEAT} fill="rgb(var(--bg))" />
          {[0.25, 0.5, 0.75].map((g) => (
            <line key={g} x1={0} x2={W} y1={H_HEAT - g * (H_HEAT - 4)} y2={H_HEAT - g * (H_HEAT - 4)} stroke="rgb(var(--line))" strokeDasharray="2 4" />
          ))}
          {heatPath ? (
            <>
              <path d={heatPath.fill} fill="url(#heatfill)" />
              <path d={heatPath.line} fill="none" stroke="rgb(var(--accent))" strokeWidth={1.5} />
            </>
          ) : (
            <text x={6} y={H_HEAT / 2 + 4} className="fill-faint text-xs">
              No “Most replayed” data for this video
            </text>
          )}
        </g>
        {/* clip ranges */}
        <g transform={`translate(0,${yClip})`}>
          {clips.map((c) => {
            const st = decisionStyle(c.approved);
            const x0 = x(c.cut_in);
            const w = Math.max(3, x(c.cut_out) - x0);
            return (
              <g
                key={c.id}
                className="cursor-pointer"
                onPointerDown={(e) => {
                  if (!onClipClick) return;
                  e.stopPropagation();
                  onClipClick(c);
                }}
              >
                <title>{`${c.id} · ${c.title} · ${fmtClock(c.cut_in)}–${fmtClock(c.cut_out)} · ${st.label}`}</title>
                <rect x={x0} y={2} width={w} height={H_CLIP - 4} rx={2} fill={st.stroke} fillOpacity={c.approved === false ? 0.35 : 0.8} />
                {w > 28 ? (
                  <text x={x0 + 4} y={H_CLIP - 6} className="fill-bg font-mono text-xs" style={{ fontSize: 10 }} pointerEvents="none">
                    {c.id}
                  </text>
                ) : null}
              </g>
            );
          })}
        </g>
        {/* axis */}
        <g transform={`translate(0,${yAxis})`}>
          {ticks.map((t) => (
            <g key={t}>
              <line x1={x(t)} x2={x(t)} y1={0} y2={4} stroke="rgb(var(--faint))" />
              {x(t) < W - 30 ? (
                <text x={x(t) + 3} y={14} className="fill-faint font-mono" style={{ fontSize: 11 }}>
                  {fmtClock(t)}
                </text>
              ) : null}
            </g>
          ))}
        </g>
        {hover !== null ? <line x1={x(hover)} x2={x(hover)} y1={0} y2={yAxis} stroke="rgb(var(--fg))" strokeOpacity={0.25} /> : null}
        {/* playhead */}
        <g transform={`translate(${x(Math.min(d, Math.max(0, time)))},0)`} pointerEvents="none">
          <line x1={0} x2={0} y1={0} y2={yAxis} stroke="rgb(var(--accent))" strokeWidth={2} />
          <path d="M-5,0 L5,0 L0,6 Z" fill="rgb(var(--accent))" />
        </g>
      </svg>
      {hoverInfo ? (
        <div
          className="pointer-events-none absolute -top-8 z-10 whitespace-nowrap rounded border border-line bg-raised px-2 py-0.5 text-xs text-fg shadow"
          style={{ left: Math.min(Math.max(0, x(hoverInfo.t) - 60), Math.max(0, W - 200)) }}
        >
          <span className="font-mono tnum">{fmtClock(hoverInfo.t)}</span>
          {hoverInfo.heat ? <span className="ml-2 text-accent">heat {hoverInfo.heat.value.toFixed(2)}</span> : null}
          {hoverInfo.ch ? <span className="ml-2 text-muted">{hoverInfo.ch.title}</span> : null}
        </div>
      ) : null}
      <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted" aria-hidden>
        <span className="inline-flex items-center gap-1.5">
          <span className="h-2 w-4 rounded-sm bg-accent/60" /> Most replayed
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="h-2 w-4 rounded-sm bg-ok" /> approved
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="h-2 w-4 rounded-sm bg-warn" /> undecided
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="h-2 w-4 rounded-sm bg-bad/50" /> rejected
        </span>
      </div>
    </div>
  );
}
