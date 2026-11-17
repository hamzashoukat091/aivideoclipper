import { ArrowUpRight, Film, FileVideo, Info } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Panel, PanelGroup } from "react-resizable-panels";
import { Link, useSearchParams } from "react-router-dom";
import { ApiError } from "@/api/client";
import { useSelection, useTranscript } from "@/api/hooks";
import type { Candidate } from "@/api/types";
import { VideoBox, type MediaStatus } from "@/components/media/VideoBox";
import { ResizeHandle } from "@/components/ui/ResizeHandle";
import { Button } from "@/components/ui/Button";
import { EmptyState, ErrorState, SkeletonRows } from "@/components/ui/Feedback";
import { useJobContext } from "@/features/job/context";
import { useRunAction } from "@/features/job/useRunAction";
import { cn } from "@/lib/cn";
import { decisionStyle } from "@/lib/decision";
import { fmtClock } from "@/lib/format";
import { useHotkeys } from "@/lib/hotkeys";
import { useMediaTime } from "@/lib/media";
import { isActive } from "@/lib/stages";
import { useMediaQuery } from "@/lib/useMediaQuery";
import { SourceTimeline } from "./SourceTimeline";
import { TranscriptPanel } from "./TranscriptPanel";


export default function SourcePage() {
  const { job } = useJobContext();
  const wide = useMediaQuery("(min-width: 1280px)");
  const transcript = useTranscript(job.id);
  const selection = useSelection(job.id);
  const actions = useRunAction(job.id);
  const [video, setVideo] = useState<HTMLVideoElement | null>(null);
  const [status, setStatus] = useState<MediaStatus>("none");
  const [params] = useSearchParams();
  const startT = Number(params.get("t") ?? "0");
  const [cursor, setCursor] = useState(Number.isFinite(startT) && startT > 0 ? startT : 0);
  const media = useMediaTime(status === "ready" ? video : null);
  const playable = status === "ready";
  const time = playable ? media.time : cursor;
  const duration = job.duration ?? (media.duration || 0);
  const fps = job.fps ?? 30;
  const clips: Candidate[] = selection.data?.candidates ?? [];
  const sm = job.source_media;
  const src = sm ? (sm.proxy_url ?? sm.url) : null;
  const proxyRunning = job.active_run?.action === "proxy";

  const seek = useCallback(
    (t: number) => {
      const c = Math.max(0, Math.min(duration || t, t));
      if (video && playable) video.currentTime = c;
      setCursor(c);
    },
    [video, playable, duration],
  );

  // Deep link ?t=<seconds> (e.g. from "Watch in source"): seek once the media is ready.
  useEffect(() => {
    if (playable && video && Number.isFinite(startT) && startT > 0) video.currentTime = startT;
  }, [playable, video, startT]);

  useHotkeys({
    space: () => {
      if (!video || !playable) return;
      if (video.paused) void video.play().catch(() => undefined);
      else video.pause();
    },
    arrowright: (e) => seek(time + (e.shiftKey ? 1 : 1 / fps)),
    arrowleft: (e) => seek(time - (e.shiftKey ? 1 : 1 / fps)),
  });

  const makeProxy = (
    <Button size="sm" variant="primary" icon={<FileVideo className="size-3.5" aria-hidden />} loading={actions.pendingAction === "proxy" || proxyRunning} disabled={isActive(job.active_run)} onClick={() => actions.run({ action: "proxy" })}>
      {proxyRunning ? "Making preview copy…" : "Make preview copy (720p, free)"}
    </Button>
  );

  const player = (
    <div className="space-y-4">
      {!sm ? (
        <div className="flex aspect-video items-center justify-center rounded border border-line bg-panel">
          <EmptyState icon={Film} title="No source yet">
            Run <span className="font-mono">ingest</span> from the Overview to download or read the master.
          </EmptyState>
        </div>
      ) : (
        <>
          <VideoBox
            ref={setVideo}
            src={src}
            label="Source video"
            controls
            boxClassName="aspect-video w-full rounded border border-line"
            onStatus={(s) => setStatus(s)}
            errorAction={!sm.proxy_url ? makeProxy : null}
          />
          {!sm.playable_hint && !sm.proxy_url && status !== "ready" ? (
            <p className="flex items-start gap-2 text-xs text-muted">
              <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />
              The master is not a typical browser format. If it does not play, make a 720p preview copy (UI cache only — the pipeline always uses the master).
            </p>
          ) : null}
          {sm.proxy_url ? <p className="text-xs text-muted">Playing the 720p preview copy (ui/source_proxy.mp4). Crops and renders always use the master.</p> : null}
        </>
      )}
      <div className="rounded border border-line bg-panel p-3 pt-10">
        {duration > 0 ? (
          <SourceTimeline
            duration={duration}
            time={time}
            heatmap={job.heatmap}
            chapters={job.chapters}
            clips={clips}
            onSeek={seek}
            onClipClick={(c) => seek(c.cut_in)}
          />
        ) : (
          <p className="text-sm text-muted">The timeline appears once the source is ingested.</p>
        )}
      </div>
      {clips.length ? (
        <ul className="flex flex-wrap gap-2" aria-label="Clip candidates">
          {clips.map((c) => {
            const st = decisionStyle(c.approved);
            return (
              <li key={c.id} className="flex items-center overflow-hidden rounded border border-line bg-panel text-sm">
                <button type="button" onClick={() => seek(c.cut_in)} className="row-hover flex items-center gap-2 px-2.5 py-1.5" title={`Seek to ${c.title}`}>
                  <span className={cn("size-2 rounded-full", st.bg)} aria-label={st.label} />
                  <span className="font-mono text-xs text-muted">{c.id}</span>
                  <span className="max-w-[220px] truncate text-fg">{c.title}</span>
                  <span className="font-mono text-xs text-faint tnum">
                    {fmtClock(c.cut_in)}–{fmtClock(c.cut_out)}
                  </span>
                </button>
                <Link to={`/jobs/${job.id}/clips/${c.id}`} className="row-hover border-l border-line px-2 py-1.5 text-muted hover:text-accent" aria-label={`Open ${c.id} in Studio`}>
                  <ArrowUpRight className="size-3.5" aria-hidden />
                </Link>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );

  const transcriptPane = (
    <div className="flex h-full min-h-0 flex-col overflow-hidden rounded border border-line bg-panel">
      {transcript.isLoading ? (
        <SkeletonRows rows={10} className="p-3" />
      ) : transcript.isError ? (
        transcript.error instanceof ApiError && transcript.error.status === 404 ? (
          <EmptyState icon={Film} title="No transcript yet">
            Run <span className="font-mono">transcribe</span> and <span className="font-mono">sentences</span> from the Overview.
          </EmptyState>
        ) : (
          <ErrorState error={transcript.error} onRetry={() => void transcript.refetch()} />
        )
      ) : transcript.data ? (
        <TranscriptPanel transcript={transcript.data} clips={clips} time={time} onSeek={seek} />
      ) : null}
    </div>
  );

  if (!wide) {
    return (
      <div className="space-y-4 p-4 sm:p-6">
        {player}
        <div className="h-[560px]">{transcriptPane}</div>
      </div>
    );
  }
  return (
    <PanelGroup direction="horizontal" autoSaveId="source-split" className="h-full p-4 sm:p-6">
      <Panel defaultSize={62} minSize={40} className="!overflow-y-auto pr-1">
        {player}
      </Panel>
      <ResizeHandle />
      <Panel defaultSize={38} minSize={24}>
        {transcriptPane}
      </Panel>
    </PanelGroup>
  );
}
