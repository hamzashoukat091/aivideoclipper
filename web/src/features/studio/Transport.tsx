import { Pause, Play, Repeat, SkipBack, SkipForward, StepBack, StepForward, Volume2, VolumeX } from "lucide-react";
import { IconButton } from "@/components/ui/Button";
import { Segmented } from "@/components/ui/Segmented";
import { cn } from "@/lib/cn";
import type { ClipClock, ClockState } from "@/lib/clipClock";
import { fmtClock } from "@/lib/format";

const RATES = ["0.25", "0.5", "1", "1.5", "2"] as const;

/**
 * `range` (clock time of the clip's in and out, used in Edit mode where the clock also covers context around the
 * clip): the time readout is then clip-relative and Start/End jump to the in/out points.
 */
export function Transport({ clock, cs, fps, frames, frame, range }: { clock: ClipClock; cs: ClockState; fps: number; frames: number; frame: number; range?: [number, number] }) {
  const [r0, r1] = range ?? [0, clock.duration];
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
      <div className="flex items-center gap-0.5">
        <IconButton label={range ? "Go to in point" : "Go to start"} shortcut="Home" onClick={() => clock.seek(r0 + (range ? 0.5 / fps : 0))}>
          <SkipBack className="size-4" aria-hidden />
        </IconButton>
        <IconButton label="Previous frame" shortcut="←" onClick={() => clock.step(-1)}>
          <StepBack className="size-4" aria-hidden />
        </IconButton>
        <IconButton label={cs.playing ? "Pause" : "Play"} shortcut="Space" variant="primary" className="size-9 rounded-full" onClick={() => clock.toggle()}>
          {cs.playing ? <Pause className="size-4" aria-hidden /> : <Play className="ml-0.5 size-4" aria-hidden />}
        </IconButton>
        <IconButton label="Next frame" shortcut="→" onClick={() => clock.step(1)}>
          <StepForward className="size-4" aria-hidden />
        </IconButton>
        <IconButton label={range ? "Go to out point" : "Go to end"} shortcut="End" onClick={() => clock.seek(r1 - 0.5 / fps)}>
          <SkipForward className="size-4" aria-hidden />
        </IconButton>
      </div>
      <div className="font-mono text-sm text-fg tnum" aria-live="off">
        {fmtClock(cs.t - r0, { ms: true })}
        <span className="text-faint"> / {fmtClock(r1 - r0, { ms: true })}</span>
      </div>
      <div className="font-mono text-xs text-muted tnum" title="Frame index into the reframe plan">
        f {frame}
        <span className="text-faint">/{Math.max(0, frames - 1)}</span>
      </div>
      <div className="ml-auto flex items-center gap-1.5">
        <IconButton label={cs.loop ? "Loop: on" : "Loop: off"} shortcut="L" aria-pressed={cs.loop} className={cn(cs.loop && "text-accent")} onClick={() => clock.setLoop(!cs.loop)}>
          <Repeat className="size-4" aria-hidden />
        </IconButton>
        <IconButton label={cs.muted ? "Unmute" : "Mute"} shortcut="M" aria-pressed={cs.muted} onClick={() => clock.setMuted(!cs.muted)}>
          {cs.muted ? <VolumeX className="size-4" aria-hidden /> : <Volume2 className="size-4" aria-hidden />}
        </IconButton>
        <Segmented
          size="sm"
          label="Playback speed"
          value={String(cs.rate) as (typeof RATES)[number]}
          onChange={(v) => clock.setRate(Number(v))}
          options={RATES.map((r) => ({ value: r, label: <span className="font-mono">{r}×</span>, ariaLabel: `${r} times speed` }))}
        />
      </div>
    </div>
  );
}
