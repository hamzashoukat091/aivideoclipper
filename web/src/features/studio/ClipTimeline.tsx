import { useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import type { CaptionEvent, ReframePlan } from "@/api/types";
import { captionChunks } from "@/lib/captions";
import { hardCutFrames, LAYOUT_COLOR } from "@/lib/crop";
import { fmtClock } from "@/lib/format";
import { useElementSize } from "@/lib/useNow";

const PAD = 64; // left gutter for row labels
const ROW_SHOT = 22;
const ROW_CAP = 14;
const ROW_HOOK = 8;
const AXIS = 18;
const HANDLE_HIT = 7;

export interface TimelineEdit {
  /** Trim in/out in timeline time. */
  trimIn: number;
  trimOut: number;
  onTrim: (which: "in" | "out", t: number, noSnap: boolean) => void;
  /** Word spans in timeline time; hidden words are drawn faint. */
  words: { start: number; end: number; hidden: boolean; edited: boolean }[];
  selectedShot: number | null;
  onSelectShot: (i: number) => void;
  shotLabel: (i: number) => { text: string; edited: boolean };
  /** Hook span in timeline time, or null when the hook is off. */
  hook: [number, number] | null;
}

/**
 * Shared clip timeline (UI_SPEC 5.6, 5b): shots coloured by layout, hard cuts, caption chunks (or word ticks
 * while editing), hook span, playhead, in/out. Click/drag to seek; ←/→ one frame, Shift ±1 s, Home/End.
 * In edit mode the in/out handles trim the clip (snap handled by the caller; Alt disables it).
 */
export function ClipTimeline({
  duration,
  fps,
  t,
  plan,
  events,
  origin,
  cutIn,
  cutOut,
  onSeek,
  edit,
}: {
  duration: number;
  fps: number;
  t: number;
  plan: ReframePlan | null;
  events: CaptionEvent[];
  /** Source time at timeline 0 (defaults to cutIn). */
  origin?: number;
  cutIn: number;
  cutOut: number;
  onSeek: (t: number) => void;
  edit?: TimelineEdit;
}) {
  const [el, setEl] = useState<HTMLDivElement | null>(null);
  const { width } = useElementSize(el);
  const [hover, setHover] = useState<number | null>(null);
  const drag = useRef<"scrub" | "in" | "out" | null>(null);
  const W = Math.max(1, width - PAD);
  const d = Math.max(0.001, duration);
  const o = origin ?? cutIn;
  const x = (s: number) => PAD + (Math.max(0, Math.min(d, s)) / d) * W;
  const chunks = useMemo(() => captionChunks(events), [events]);
  const hooks = useMemo(() => events.filter((e) => e.kind === "hook"), [events]);

  const yShot = 0;
  const yCap = ROW_SHOT + 6;
  const yHook = yCap + ROW_CAP + 6;
  const yAxis = yHook + ROW_HOOK + 4;
  const H = yAxis + AXIS;

  const stepS = [0.5, 1, 2, 5, 10, 15, 30].find((s) => (W / d) * s >= 56) ?? 30;
  const ticks: number[] = [];
  for (let s = 0; s <= d + 1e-6; s += stepS) ticks.push(s);

  const fpsPlan = plan ? plan.frames / Math.max(0.001, plan.duration) : fps;
  const planOff = plan ? plan.cut_in - o : 0; // timeline time of plan frame 0
  const ft = (f: number) => planOff + f / fpsPlan;

  const tFrom = (e: PointerEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return Math.max(0, Math.min(d, ((e.clientX - r.left - PAD) / W) * d));
  };
  const onKey = (e: KeyboardEvent) => {
    const big = e.shiftKey ? 1 : 1 / fps;
    if (e.key === "ArrowRight") onSeek(t + big);
    else if (e.key === "ArrowLeft") onSeek(t - big);
    else if (e.key === "Home") onSeek(edit ? edit.trimIn : 0);
    else if (e.key === "End") onSeek(edit ? edit.trimOut - 0.5 / fps : d);
    else return;
    e.preventDefault();
    e.stopPropagation();
  };
  const label = (txt: string, y: number, h: number) => (
    <text x={0} y={y + h / 2 + 4} className="fill-faint" style={{ fontSize: 11 }}>
      {txt}
    </text>
  );
  const shotAt = (tt: number) => (plan ? plan.shots.findIndex((s) => tt >= ft(s.f0) && tt < ft(s.f1)) : -1);

  return (
    <div ref={setEl} className="relative select-none">
      {width > 0 ? (
        <svg
          width={width}
          height={H}
          role="slider"
          tabIndex={0}
          aria-label="Clip timeline"
          aria-valuemin={0}
          aria-valuemax={Number(d.toFixed(2))}
          aria-valuenow={Number(t.toFixed(2))}
          aria-valuetext={`${fmtClock(t, { ms: true })} of ${fmtClock(d, { ms: true })}`}
          onKeyDown={onKey}
          className="block cursor-pointer focus-visible:outline-offset-4"
          onPointerDown={(e) => {
            const v = tFrom(e);
            const r = e.currentTarget.getBoundingClientRect();
            const px = e.clientX - r.left;
            const py = e.clientY - r.top;
            e.currentTarget.setPointerCapture(e.pointerId);
            if (edit && Math.abs(px - x(edit.trimIn)) <= HANDLE_HIT) drag.current = "in";
            else if (edit && Math.abs(px - x(edit.trimOut)) <= HANDLE_HIT) drag.current = "out";
            else {
              drag.current = "scrub";
              if (edit && py <= ROW_SHOT) {
                const i = shotAt(v);
                if (i >= 0) edit.onSelectShot(i);
              }
              onSeek(v);
            }
          }}
          onPointerMove={(e) => {
            const v = tFrom(e);
            setHover(v);
            if (drag.current === "scrub") onSeek(v);
            else if (drag.current && edit) edit.onTrim(drag.current, v, e.altKey);
          }}
          onPointerUp={() => {
            drag.current = null;
          }}
          onPointerLeave={() => setHover(null)}
        >
          {label("shots", yShot, ROW_SHOT)}
          {label(edit ? "words" : "captions", yCap, ROW_CAP)}
          {label("hook", yHook, ROW_HOOK)}
          <rect x={PAD} y={yShot} width={W} height={ROW_SHOT} rx={3} fill="rgb(var(--panel-2))" />
          {plan ? (
            plan.shots.map((s, i) => {
              const x0 = x(ft(s.f0));
              const x1 = x(ft(s.f1));
              const w = Math.max(1, x1 - x0 - 1);
              const lab = edit ? edit.shotLabel(i) : { text: s.layout, edited: false };
              const sel = edit?.selectedShot === i;
              return (
                <g key={i}>
                  <title>{`Shot ${i + 1}: ${lab.text} · frames ${s.f0}–${s.f1}${s.hold_frame !== undefined && s.hold_frame !== null ? " · held frame" : ""} · ${s.reason ?? ""}`}</title>
                  <rect
                    x={x0}
                    y={yShot}
                    width={w}
                    height={ROW_SHOT}
                    rx={3}
                    fill={LAYOUT_COLOR[s.layout]}
                    fillOpacity={sel ? 0.5 : 0.28}
                    stroke={sel ? "rgb(var(--accent))" : LAYOUT_COLOR[s.layout]}
                    strokeOpacity={sel ? 1 : 0.7}
                    strokeWidth={sel ? 2 : 1}
                  />
                  {w > 44 ? (
                    <text x={x0 + 6} y={yShot + 15} className="font-mono" style={{ fontSize: 11 }} fill={lab.edited ? "rgb(var(--accent))" : LAYOUT_COLOR[s.layout]} pointerEvents="none">
                      {lab.text}
                    </text>
                  ) : null}
                  {hardCutFrames(s).map((f) => (
                    <line key={f} x1={x(ft(f))} x2={x(ft(f))} y1={yShot - 2} y2={yShot + ROW_SHOT + 2} stroke="rgb(var(--fg))" strokeWidth={1.5} />
                  ))}
                </g>
              );
            })
          ) : (
            <text x={PAD + 6} y={yShot + 15} className="fill-faint" style={{ fontSize: 11 }}>
              No reframe plan
            </text>
          )}
          <rect x={PAD} y={yCap} width={W} height={ROW_CAP} rx={2} fill="rgb(var(--panel-2))" />
          {edit
            ? edit.words.map((w, i) => (
                <rect
                  key={i}
                  x={x(w.start)}
                  y={yCap + 3}
                  width={Math.max(1, x(w.end) - x(w.start) - 1)}
                  height={ROW_CAP - 6}
                  rx={1}
                  fill={w.edited ? "rgb(var(--accent))" : "rgb(var(--muted))"}
                  fillOpacity={w.hidden ? 0.12 : w.edited ? 0.8 : 0.45}
                />
              ))
            : chunks.map((c, i) => {
                const active = t >= c.start && t < c.end;
                return (
                  <rect key={i} x={x(c.start)} y={yCap} width={Math.max(1, x(c.end) - x(c.start) - 1)} height={ROW_CAP} rx={2} fill={active ? "rgb(var(--accent))" : i % 2 ? "rgb(var(--muted))" : "rgb(var(--faint))"} fillOpacity={active ? 0.9 : 0.35}>
                    <title>{`${fmtClock(c.start, { ms: true })} ${c.text}`}</title>
                  </rect>
                );
              })}
          <rect x={PAD} y={yHook} width={W} height={ROW_HOOK} rx={2} fill="rgb(var(--panel-2))" />
          {(edit ? (edit.hook ? [{ start: edit.hook[0], end: edit.hook[1], text: "Hook" }] : []) : hooks).map((h, i) => (
            <rect key={i} x={x(h.start)} y={yHook} width={Math.max(2, x(h.end) - x(h.start))} height={ROW_HOOK} rx={2} fill="rgb(var(--accent))" fillOpacity={0.7}>
              <title>{`Hook: ${h.text}`}</title>
            </rect>
          ))}
          {ticks.map((s) => (
            <g key={s}>
              <line x1={x(s)} x2={x(s)} y1={yAxis} y2={yAxis + 4} stroke="rgb(var(--faint))" />
              {x(s) < width - 28 ? (
                <text x={x(s) + 3} y={yAxis + 14} className="fill-faint font-mono" style={{ fontSize: 11 }}>
                  {s < 60 ? `${Math.round(s * 10) / 10}s` : fmtClock(s)}
                </text>
              ) : null}
            </g>
          ))}
          {edit ? (
            <g>
              {/* outside the trim: dimmed */}
              <rect x={PAD} y={0} width={Math.max(0, x(edit.trimIn) - PAD)} height={yAxis} fill="rgb(var(--bg))" fillOpacity={0.62} pointerEvents="none" />
              <rect x={x(edit.trimOut)} y={0} width={Math.max(0, PAD + W - x(edit.trimOut))} height={yAxis} fill="rgb(var(--bg))" fillOpacity={0.62} pointerEvents="none" />
              {(["in", "out"] as const).map((k) => {
                const hx = x(k === "in" ? edit.trimIn : edit.trimOut);
                return (
                  <g key={k} className="cursor-ew-resize">
                    <rect x={hx - HANDLE_HIT} y={-2} width={HANDLE_HIT * 2} height={yAxis + 4} fill="transparent" />
                    <rect x={hx - 2} y={-2} width={4} height={yAxis + 2} rx={2} fill="rgb(var(--accent))" />
                    <path d={k === "in" ? `M${hx + 2},-2 h6 v8 h-6 Z` : `M${hx - 2},-2 h-6 v8 h6 Z`} fill="rgb(var(--accent))" />
                  </g>
                );
              })}
            </g>
          ) : null}
          {hover !== null ? <line x1={x(hover)} x2={x(hover)} y1={0} y2={yAxis} stroke="rgb(var(--fg))" strokeOpacity={0.25} pointerEvents="none" /> : null}
          <g transform={`translate(${x(t)},0)`} pointerEvents="none">
            {/* accent playhead; white while editing so it reads apart from the accent trim handles */}
            <line x1={0} x2={0} y1={0} y2={yAxis + 2} stroke={edit ? "rgb(var(--fg))" : "rgb(var(--accent))"} strokeWidth={2} />
            <path d="M-5,-1 L5,-1 L0,5 Z" fill={edit ? "rgb(var(--fg))" : "rgb(var(--accent))"} />
          </g>
        </svg>
      ) : (
        <div style={{ height: H }} />
      )}
      <div className="mt-1 flex items-center justify-between pl-16 font-mono text-xs text-faint tnum">
        <span title="Cut in (source time)">in {fmtClock(cutIn, { ms: true })}</span>
        {hover !== null ? <span className="text-muted">{fmtClock(o + hover, { ms: true })}</span> : null}
        <span title="Cut out (source time)">out {fmtClock(cutOut, { ms: true })}</span>
      </div>
    </div>
  );
}
