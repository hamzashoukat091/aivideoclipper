import { Crosshair, Search, Volume2 } from "lucide-react";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import type { Candidate, Sentence, Transcript } from "@/api/types";
import { IconButton } from "@/components/ui/Button";
import { cn } from "@/lib/cn";
import { decisionStyle } from "@/lib/decision";
import { fmtClock } from "@/lib/format";

function activeIndex(sentences: Sentence[], t: number): number {
  let lo = 0;
  let hi = sentences.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (sentences[mid].start <= t) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}

function highlight(text: string, q: string) {
  if (!q) return text;
  const i = text.toLowerCase().indexOf(q.toLowerCase());
  if (i < 0) return text;
  return (
    <>
      {text.slice(0, i)}
      <mark className="rounded-sm bg-accent/30 text-fg">{text.slice(i, i + q.length)}</mark>
      {text.slice(i + q.length)}
    </>
  );
}

/** Only mark sentences the audience actually replays (top of the curve); a bar on every row is noise. */
const HOT = 0.5;

const Row = memo(function Row({
  s,
  active,
  clip,
  clipStart,
  q,
  onSeek,
}: {
  s: Sentence;
  active: boolean;
  clip: Candidate | null;
  clipStart: boolean;
  q: string;
  onSeek: (t: number) => void;
}) {
  const st = clip ? decisionStyle(clip.approved) : null;
  const hot = s.heat !== null && s.heat >= HOT;
  const loud = s.loud_z >= 1.5;
  const pause = s.pause_before !== undefined && s.pause_before >= 1.5;
  const meta = !!s.speaker || hot || loud || pause;
  return (
    <li
      data-i={s.i}
      className={cn("content-auto relative border-l-2 border-transparent", active && "bg-accent/[0.07]")}
      style={st ? { borderLeftColor: st.stroke } : undefined}
    >
      {clipStart && clip ? (
        <div className="flex items-center gap-1.5 px-3 pt-2 text-xs">
          <span className={cn("font-mono font-medium", st?.text)}>{clip.id}</span>
          <span className="truncate text-muted">{clip.title}</span>
        </div>
      ) : null}
      <button
        type="button"
        onClick={() => onSeek(s.start)}
        className="row-hover group flex w-full items-start gap-3 px-3 py-1.5 text-left"
        aria-current={active ? "true" : undefined}
      >
        <span className={cn("w-12 shrink-0 pt-px font-mono text-xs tnum", active ? "text-accent" : "text-faint group-hover:text-muted")}>{fmtClock(s.start)}</span>
        <span className="min-w-0 flex-1">
          <span className={cn("text-sm leading-relaxed", active ? "text-fg" : "text-fg/85")}>{highlight(s.text, q)}</span>
          {meta ? <span className="mt-0.5 flex items-center gap-2">
            {s.speaker ? <span className="rounded-sm bg-run/15 px-1 font-mono text-xs text-run">{s.speaker}</span> : null}
            {hot && s.heat !== null ? (
              <span className="inline-flex items-center gap-1" title={`Most replayed: heat ${s.heat.toFixed(2)}`} aria-label={`Most replayed, heat ${s.heat.toFixed(2)}`} role="img">
                <span className="h-1 w-8 overflow-hidden rounded-full bg-raised">
                  <span className="block h-full rounded-full bg-accent/80" style={{ width: `${Math.round(s.heat * 100)}%` }} />
                </span>
              </span>
            ) : null}
            {loud ? (
              <span className="inline-flex items-center gap-0.5 text-xs text-warn" title={`Loudness z ${s.loud_z.toFixed(2)}`}>
                <Volume2 className="size-3" aria-hidden /> loud
              </span>
            ) : null}
            {pause && s.pause_before !== undefined ? (
              <span className="font-mono text-xs text-faint" title="Pause before this sentence">
                pause {s.pause_before.toFixed(1)}s
              </span>
            ) : null}
          </span> : null}
        </span>
      </button>
    </li>
  );
});

/** Transcript (UI_SPEC 5.4): search, auto-follow playback, click to seek, clip ranges highlighted. */
export function TranscriptPanel({ transcript, clips, time, onSeek }: { transcript: Transcript; clips: Candidate[]; time: number; onSeek: (t: number) => void }) {
  const [q, setQ] = useState("");
  const [follow, setFollow] = useState(true);
  const listRef = useRef<HTMLDivElement>(null);
  const sentences = transcript.sentences;
  const act = activeIndex(sentences, time + 0.04); // seeks land on frame boundaries slightly before the sentence start

  const clipOf = useMemo(() => {
    const m = new Map<number, Candidate>();
    clips.forEach((c) => {
      for (let i = c.start_sentence; i <= c.end_sentence; i += 1) if (!m.has(i)) m.set(i, c);
    });
    return m;
  }, [clips]);

  const visible = useMemo(() => {
    const n = q.trim().toLowerCase();
    return n ? sentences.filter((s) => s.text.toLowerCase().includes(n)) : sentences;
  }, [sentences, q]);

  useEffect(() => {
    if (!follow || q || act < 0) return;
    const box = listRef.current;
    const row = box?.querySelector<HTMLElement>(`[data-i="${sentences[act]?.i}"]`);
    if (!box || !row) return;
    const top = row.offsetTop; // the list box is the offsetParent (position: relative)
    if (top < box.scrollTop + 40 || top > box.scrollTop + box.clientHeight - 80) box.scrollTo({ top: top - box.clientHeight / 3 });
  }, [act, follow, q, sentences]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-line p-2">
        <div className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-faint" aria-hidden />
          <label htmlFor="tr-search" className="sr-only">
            Search transcript
          </label>
          <input
            id="tr-search"
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={`Search ${sentences.length} sentences`}
            className="h-8 w-full rounded border border-line bg-bg pl-8 pr-2 text-sm text-fg placeholder:text-faint focus:border-accent/70 focus:outline-none"
          />
        </div>
        <IconButton label={follow ? "Auto-follow playback: on" : "Auto-follow playback: off"} aria-pressed={follow} className={cn(follow && "text-accent")} onClick={() => setFollow(!follow)}>
          <Crosshair className="size-4" aria-hidden />
        </IconButton>
      </div>
      <div className="flex shrink-0 items-center justify-between px-3 py-1.5 text-xs text-muted">
        <span>
          {q ? `${visible.length} matches` : `${transcript.word_count.toLocaleString()} words`} · {transcript.model ?? "unknown model"} · {transcript.language ?? "?"}
        </span>
      </div>
      <div ref={listRef} className="relative min-h-0 flex-1 overflow-y-auto" onWheel={() => follow && setFollow(false)}>
        {visible.length === 0 ? (
          <p className="p-4 text-sm text-muted">No sentence contains “{q}”.</p>
        ) : (
          <ol className="pb-4">
            {visible.map((s) => {
              const c = clipOf.get(s.i) ?? null;
              return <Row key={s.i} s={s} active={sentences[act]?.i === s.i} clip={c} clipStart={!!c && c.start_sentence === s.i} q={q.trim()} onSeek={onSeek} />;
            })}
          </ol>
        )}
      </div>
    </div>
  );
}
