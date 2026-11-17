import type { RunInfo, RunStep, StageKey, StageState } from "@/api/types";

export const STAGE_ORDER: StageKey[] = ["ingest", "transcribe", "diarize", "sentences", "select", "reframe", "render"];

export const STAGE_INFO: Record<StageKey, { label: string; what: string; paid?: boolean }> = {
  ingest: { label: "Ingest", what: "Download the best master (yt-dlp) or read the local file; probe, heatmap, chapters, 16 kHz audio." },
  transcribe: { label: "Transcribe", what: "WhisperX large-v3 (int8, CPU) + wav2vec2 word alignment. About 1.6× real time." },
  diarize: { label: "Diarize", what: "pyannote community-1 speaker turns, merged into words.json. Needs HF_TOKEN." },
  sentences: { label: "Sentences", what: "Sentence units with replay heat, loudness z-score and pauses." },
  select: { label: "Select clips", what: "Claude proposes, judges and reranks clips. The only PAID step.", paid: true },
  reframe: { label: "Reframe", what: "Shots, YuNet faces, tracks, LR-ASD speaker, per-shot layout and L1 camera path." },
  render: { label: "Render", what: "One x264 slow CRF 16 encode with libass captions and two-pass loudnorm." },
};

/** Text colour class + dot background per state (UI_SPEC section 6 status colours). */
export const STATE_STYLE: Record<StageState | RunStep["state"] | RunInfo["state"], { text: string; dot: string; label: string }> = {
  done: { text: "text-ok", dot: "bg-ok", label: "Done" },
  running: { text: "text-run", dot: "bg-run", label: "Running" },
  queued: { text: "text-run", dot: "bg-run/50", label: "Queued" },
  stale: { text: "text-warn", dot: "bg-warn", label: "Stale" },
  partial: { text: "text-warn", dot: "bg-warn", label: "Partial" },
  failed: { text: "text-bad", dot: "bg-bad", label: "Failed" },
  skipped: { text: "text-muted", dot: "bg-idle", label: "Skipped" },
  missing: { text: "text-muted", dot: "bg-idle/40 ring-1 ring-inset ring-idle", label: "Not run" },
  cancelled: { text: "text-muted", dot: "bg-idle", label: "Cancelled" },
};

export const ACTION_LABEL: Record<RunInfo["action"], string> = {
  prepare: "Prepare",
  ingest: "Ingest",
  transcribe: "Transcribe",
  diarize: "Diarize",
  sentences: "Sentences",
  select: "Select clips",
  reframe: "Reframe",
  render: "Render",
  produce: "Run everything",
  proxy: "Preview copy",
};

export function isActive(run: Pick<RunInfo, "state"> | null | undefined): boolean {
  return !!run && (run.state === "running" || run.state === "queued");
}

export function currentStepName(run: RunInfo): string | null {
  if (run.current_step === null || run.current_step === undefined) return null;
  return run.steps[run.current_step]?.name ?? null;
}
