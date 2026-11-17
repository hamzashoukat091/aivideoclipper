import { Check, ChevronLeft, ChevronRight, Crop, Download, FileJson, FileText, Film, Hammer, ListChecks, Pencil, RotateCw, Sparkles, Subtitles } from "lucide-react";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Panel, PanelGroup } from "react-resizable-panels";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ApiError, withDownload } from "@/api/client";
import { useCaptions, useEdits, usePatchCandidate, useReframe, useSelection } from "@/api/hooks";
import type { Candidate, JobDetail, StageState } from "@/api/types";
import { VideoBox, type MediaStatus } from "@/components/media/VideoBox";
import { Button, IconButton } from "@/components/ui/Button";
import { EmptyState, ErrorState, SkeletonRows } from "@/components/ui/Feedback";
import { MenuContent, MenuItem, MenuLabel, MenuRoot, MenuSeparator, MenuTrigger } from "@/components/ui/Menu";
import { ResizeHandle } from "@/components/ui/ResizeHandle";
import { Segmented } from "@/components/ui/Segmented";
import { StateBadge } from "@/components/ui/Status";
import { Tooltip } from "@/components/ui/Tooltip";
import { DecisionControl } from "@/features/clips/DecisionControl";
import { useJobContext } from "@/features/job/context";
import { PaidConfirmDialog } from "@/features/job/PaidConfirmDialog";
import { useRunAction } from "@/features/job/useRunAction";
import { ClipClock } from "@/lib/clipClock";
import { cn } from "@/lib/cn";
import { cropForFrame, frameIndex, LAYOUT_COLOR, LAYOUT_TEXT } from "@/lib/crop";
import { fmtClock, fmtSeconds, parseRate } from "@/lib/format";
import { useHotkeys } from "@/lib/hotkeys";
import { useDefaults } from "@/lib/settings";
import { isActive, STATE_STYLE } from "@/lib/stages";
import { toast } from "@/lib/toast";
import { useElementSize } from "@/lib/useNow";
import { useMediaQuery } from "@/lib/useMediaQuery";
import { ClipTimeline } from "./ClipTimeline";
import { EditStudio } from "./edit/EditStudio";
import { useEditor } from "./edit/useEditor";
import { CropOverlay } from "./CropOverlay";
import { LiveCropCanvas } from "./LiveCropCanvas";
import { StudioSidePanel } from "./StudioSidePanel";
import { Transport } from "./Transport";

type Mode = "render" | "preview" | "live";

function Header({
  job,
  c,
  cands,
  onRun,
  pending,
  editing,
  onToggleEdit,
  dirty,
}: {
  job: JobDetail;
  c: Candidate;
  cands: Candidate[];
  onRun: (a: "reframe" | "render", fast?: boolean) => void;
  pending: boolean;
  editing: boolean;
  onToggleEdit: () => void;
  dirty: boolean;
}) {
  const navigate = useNavigate();
  const patch = usePatchCandidate(job.id);
  const i = cands.findIndex((x) => x.id === c.id);
  const prev = i > 0 ? cands[i - 1] : null;
  const next = i >= 0 && i < cands.length - 1 ? cands[i + 1] : null;
  const busy = isActive(job.active_run);
  const decide = (v: boolean | null) =>
    patch.mutate(
      { cid: c.id, approved: v },
      { onError: (e) => toast({ tone: "error", title: `Could not update ${c.id}`, description: e instanceof ApiError ? `${e.message} (${e.code})` : String(e) }) },
    );
  const navBlocked = editing && dirty;
  // Only states that need attention are shown; "done" stays quiet (hover the title for details).
  // Edit mode shows no badges (UI_SPEC 5b): its footer already says what must run.
  const attention: { k: string; st: StageState }[] = [];
  if (!editing && c.reframe.state !== "done") attention.push({ k: "reframe", st: c.reframe.state });
  if (!editing && c.render.state !== "done") attention.push({ k: "render", st: c.render.state });
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-line px-3 py-2 sm:px-4">
      <div className="flex items-center gap-0.5">
        <IconButton
          label={navBlocked ? "Save or discard your changes first" : prev ? `Previous clip (${prev.id})` : "No previous clip"}
          shortcut={editing ? undefined : "K"}
          disabled={!prev || navBlocked}
          onClick={() => prev && navigate(`/jobs/${job.id}/clips/${prev.id}`)}
        >
          <ChevronLeft className="size-4" aria-hidden />
        </IconButton>
        <span className="px-1 font-mono text-xs text-muted tnum">
          {i + 1}/{cands.length}
        </span>
        <IconButton
          label={navBlocked ? "Save or discard your changes first" : next ? `Next clip (${next.id})` : "No next clip"}
          shortcut={editing ? undefined : "J"}
          disabled={!next || navBlocked}
          onClick={() => next && navigate(`/jobs/${job.id}/clips/${next.id}`)}
        >
          <ChevronRight className="size-4" aria-hidden />
        </IconButton>
      </div>
      <div className="min-w-[240px] flex-1">
        <h2 className="truncate text-md font-semibold text-fg" title={`#${c.rank} · ${c.title} · reframe ${c.reframe.state} · render ${c.render.state}`}>
          {c.title}
        </h2>
        <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-muted">
          <span className="font-mono">{c.id}</span>
          <span className="font-mono tnum">
            {fmtClock(c.cut_in, { ms: true })}–{fmtClock(c.cut_out, { ms: true })} · {fmtSeconds(c.duration)}
          </span>
          {attention.map(({ k, st }) => (
            <StateBadge key={k} state={st} label={`${k} ${STATE_STYLE[st].label.toLowerCase()}`} />
          ))}
          {c.cut_notes && c.cut_notes.length ? (
            <Tooltip content={c.cut_notes.join(" · ")}>
              <span tabIndex={0} className="text-faint underline decoration-dotted underline-offset-2">
                cut notes
              </span>
            </Tooltip>
          ) : null}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {!editing ? <DecisionControl clipId={c.id} value={c.approved} onChange={decide} /> : null}
        <Button size="sm" variant={editing ? "primary" : "secondary"} icon={editing ? <Check className="size-3.5" aria-hidden /> : <Pencil className="size-3.5" aria-hidden />} aria-pressed={editing} onClick={onToggleEdit}>
          {editing ? "Done" : "Edit"}
        </Button>
        {!editing ? (
          <>
            <MenuRoot>
              <MenuTrigger asChild>
                <Button size="sm" icon={<Hammer className="size-3.5" aria-hidden />} disabled={busy || pending} aria-label="Run options">
                  {c.render.state === "missing" ? "Render" : "Re-render"}
                </Button>
              </MenuTrigger>
              <MenuContent>
                <MenuLabel>Render {c.id}</MenuLabel>
                <MenuItem icon={<Sparkles className="size-3.5" />} hint="CRF 16" disabled={c.reframe.state === "missing"} onSelect={() => onRun("render", false)}>
                  Final quality
                </MenuItem>
                <MenuItem icon={<RotateCw className="size-3.5" />} hint="--fast" disabled={c.reframe.state === "missing"} onSelect={() => onRun("render", true)}>
                  Fast check
                </MenuItem>
                <MenuSeparator />
                <MenuItem icon={<Crop className="size-3.5" />} hint="~2 min" onSelect={() => onRun("reframe")}>
                  Re-analyse framing
                </MenuItem>
              </MenuContent>
            </MenuRoot>
            <MenuRoot>
              <MenuTrigger asChild>
                <IconButton label="Downloads" variant="outline" size="sm">
                  <Download className="size-3.5" aria-hidden />
                </IconButton>
              </MenuTrigger>
              <MenuContent>
                <MenuLabel>Downloads</MenuLabel>
                <MenuItem icon={<Film className="size-3.5" />} href={c.render.download_url ?? undefined} disabled={!c.render.download_url} download hint=".mp4">
                  Clip MP4
                </MenuItem>
                <MenuItem icon={<Subtitles className="size-3.5" />} href={c.render.captions_url ? withDownload(c.render.captions_url) : undefined} disabled={!c.render.captions_url} download hint=".ass">
                  Captions
                </MenuItem>
                <MenuItem
                  icon={<FileText className="size-3.5" />}
                  href={c.render.report ? withDownload(`/media/${encodeURIComponent(job.id)}/renders/${encodeURIComponent(c.id)}.report.json`) : undefined}
                  disabled={!c.render.report}
                  download
                  hint=".json"
                >
                  Render report
                </MenuItem>
                <MenuSeparator />
                <MenuItem icon={<FileJson className="size-3.5" />} href={c.reframe.url ? withDownload(c.reframe.url) : undefined} disabled={!c.reframe.url} download hint=".json">
                  Reframe plan
                </MenuItem>
                <MenuItem icon={<Film className="size-3.5" />} href={c.reframe.preview_url ? withDownload(c.reframe.preview_url) : undefined} disabled={!c.reframe.preview_url} download hint=".mp4">
                  Reframe preview
                </MenuItem>
              </MenuContent>
            </MenuRoot>
          </>
        ) : null}
      </div>
    </div>
  );
}

function ReviewStudio({ job, c, cands, actions }: { job: JobDetail; c: Candidate; cands: Candidate[]; actions: ReturnType<typeof useRunAction> }) {
  const navigate = useNavigate();
  const wide = useMediaQuery("(min-width: 1280px)");
  const defaults = useDefaults();
  const patch = usePatchCandidate(job.id);
  const planQ = useReframe(job.id, c.id, c.reframe.state !== "missing");
  const capQ = useCaptions(job.id, c.id, !!c.render.captions_url);
  const plan = planQ.data ?? null;
  const fps = (plan ? parseRate(plan.fps) : null) ?? job.fps ?? 30;
  const dur = Math.max(0.1, c.cut_out - c.cut_in);

  const clock = useMemo(() => new ClipClock(c.cut_in, dur, fps), [c.cut_in, dur, fps]);
  useEffect(() => () => clock.destroy(), [clock]);
  const cs = useSyncExternalStore(clock.subscribe, clock.getSnapshot, clock.getSnapshot);

  const modes: { value: Mode; available: boolean; label: string; why: string }[] = [
    { value: "render", available: !!c.render.video_url, label: "Render", why: "Final MP4 with captions" },
    { value: "preview", available: !!c.reframe.preview_url, label: "Preview", why: "Reframe preview (no captions)" },
    { value: "live", available: !!plan, label: "Live", why: "Drawn from the source with the reframe plan" },
  ];
  const firstAvail = modes.find((m) => m.available)?.value ?? "render";
  const [modeSel, setMode] = useState<Mode | null>(null);
  const mode = modeSel && modes.find((m) => m.value === modeSel)?.available ? modeSel : firstAvail;

  const [renderEl, setRenderEl] = useState<HTMLVideoElement | null>(null);
  const [renderStatus, setRenderStatus] = useState<MediaStatus>("none");
  const [sourceEl, setSourceEl] = useState<HTMLVideoElement | null>(null);
  const [sourceStatus, setSourceStatus] = useState<MediaStatus>("none");

  useEffect(() => {
    const useIt = mode !== "live";
    clock.setRender(useIt ? renderEl : null, useIt && renderStatus === "ready");
    return () => clock.setRender(null, false);
  }, [clock, renderEl, renderStatus, mode]);
  useEffect(() => {
    clock.setSource(sourceEl, sourceStatus === "ready");
    return () => clock.setSource(null, false);
  }, [clock, sourceEl, sourceStatus]);

  // Held-frame edge shots (Shot.hold_frame): the source shows that frame, frozen, with the shot's own framing.
  useEffect(() => {
    if (!plan) return;
    const pf = plan.frames / Math.max(1e-6, plan.duration);
    clock.setHold((t) => {
      const fr = Math.floor(t * pf);
      const s = plan.shots.find((x) => fr >= x.f0 && fr < x.f1);
      return s && s.hold_frame !== undefined && s.hold_frame !== null ? plan.cut_in + (s.hold_frame + 0.5) / pf : null;
    });
    return () => clock.setHold(null);
  }, [clock, plan]);

  const planCutIn = plan?.cut_in ?? c.cut_in;
  const frameByT = plan ? Math.min(plan.frames - 1, Math.max(0, Math.floor(cs.t * fps))) : 0;
  const heldShot = plan ? plan.shots.find((x) => frameByT >= x.f0 && frameByT < x.f1 && x.hold_frame !== undefined && x.hold_frame !== null) : undefined;
  const frame = plan ? (heldShot ? frameByT : frameIndex(cs.sourceT, planCutIn, fps, plan.frames, cs.sourceLive)) : Math.floor(cs.t * fps);
  const crop = useMemo(() => (plan ? cropForFrame(plan, frame) : null), [plan, frame]);
  const stalePlan = plan && (Math.abs(plan.cut_in - c.cut_in) > 0.01 || Math.abs(plan.cut_out - c.cut_out) > 0.01);

  const go = (d: number) => {
    const i = cands.findIndex((x) => x.id === c.id) + d;
    if (i >= 0 && i < cands.length) navigate(`/jobs/${job.id}/clips/${cands[i].id}`);
  };
  const decide = (v: boolean) => patch.mutate({ cid: c.id, approved: v });
  useHotkeys({
    space: () => clock.toggle(),
    arrowright: (e) => (e.shiftKey ? clock.seek(clock.getSnapshot().t + 1) : clock.step(1)),
    arrowleft: (e) => (e.shiftKey ? clock.seek(clock.getSnapshot().t - 1) : clock.step(-1)),
    home: () => clock.seek(0),
    end: () => clock.seek(dur - 0.5 / fps),
    l: () => clock.setLoop(!cs.loop),
    m: () => clock.setMuted(!cs.muted),
    j: () => go(1),
    k: () => go(-1),
    a: () => decide(true),
    r: () => decide(false),
  });

  const runClip = (a: "reframe" | "render", fast?: boolean) =>
    actions.run(a === "reframe" ? { action: "reframe", clips: [c.id], force: true, preview: defaults.previewReframes } : { action: "render", clips: [c.id], force: true, fast: !!fast });

  const sm = job.source_media;
  const sourceSrc = sm ? (sm.proxy_url ?? sm.url) : null;
  const [rowEl, setRowEl] = useState<HTMLDivElement | null>(null);
  const row = useElementSize(rowEl);
  const leftW = Math.max(160, Math.min((row.height - 32) * (9 / 16), row.width * 0.42));

  const renderSrc = mode === "render" ? c.render.video_url : mode === "preview" ? c.reframe.preview_url : null;
  const proxyBtn =
    sm && !sm.proxy_url ? (
      <Button size="sm" variant="primary" disabled={isActive(job.active_run)} onClick={() => actions.run({ action: "proxy" })}>
        Make preview copy (free)
      </Button>
    ) : null;

  const left = (
    <div className="flex h-full shrink-0 flex-col gap-2" style={{ width: leftW }}>
      <Segmented<Mode>
        size="sm"
        label="9:16 view"
        value={mode}
        onChange={setMode}
        className="self-start"
        options={modes.map((m) => ({
          value: m.value,
          label: m.label,
          title: m.available ? m.why : `${m.why} — not available`,
          ariaLabel: m.label,
          disabled: !m.available,
        }))}
      />
      <div className="relative min-h-0 flex-1">
        {mode === "live" && plan && crop ? (
          <div className="absolute inset-0 overflow-hidden rounded border border-line bg-black">
            <LiveCropCanvas video={sourceStatus === "ready" ? sourceEl : null} plan={plan} crop={crop} frameKey={cs.sourceT} />
            {sourceStatus !== "ready" ? (
              <div className="absolute inset-0 flex items-center justify-center p-4 text-center text-xs text-muted">The live crop needs the source video to play in the browser.</div>
            ) : null}
            <span className="absolute left-2 top-2 rounded-sm bg-black/70 px-1.5 py-0.5 text-xs text-muted">live · no captions</span>
          </div>
        ) : (
          <VideoBox
            key={renderSrc ?? "none"}
            ref={setRenderEl}
            src={renderSrc}
            poster={mode === "render" ? (c.render.poster_url ?? undefined) : undefined}
            label={mode === "render" ? `Rendered clip ${c.id}` : `Reframe preview ${c.id}`}
            boxClassName="absolute inset-0 rounded border border-line"
            onStatus={(s) => setRenderStatus(s)}
            onClick={() => clock.toggle()}
            emptyContent={
              <div className="flex flex-col items-center gap-3 text-center">
                <Film className="size-6 text-faint" aria-hidden />
                <p className="text-sm text-muted">Not rendered yet</p>
                <Button size="sm" variant="primary" disabled={isActive(job.active_run) || c.reframe.state === "missing"} onClick={() => runClip("render", defaults.fastRenders)}>
                  Render {c.id}
                </Button>
                {c.reframe.state === "missing" ? <p className="text-xs text-faint">Reframe first.</p> : null}
              </div>
            }
          >
            {mode === "preview" ? <span className="absolute left-2 top-2 rounded-sm bg-black/70 px-1.5 py-0.5 text-xs text-muted">reframe preview</span> : null}
          </VideoBox>
        )}
      </div>
    </div>
  );

  const center = (
    <div className="flex h-full min-w-0 flex-1 flex-col gap-2">
      <div className="flex h-7 min-w-0 items-center gap-2 overflow-hidden text-xs">
        <span className="shrink-0 text-muted">Source 16:9</span>
        {crop?.layout ? (
          <Tooltip content={LAYOUT_TEXT[crop.layout]}>
            <span tabIndex={0} className="shrink-0 rounded-sm px-1.5 py-0.5 font-mono font-medium" style={{ color: LAYOUT_COLOR[crop.layout], background: "rgb(var(--raised))" }}>
              {crop.layout}
            </span>
          </Tooltip>
        ) : null}
        {plan && crop ? (
          <span className="min-w-0 truncate text-muted" title={`${crop.shot?.reason ?? ""} · speaker evidence: ${plan.speaker_evidence}`}>
            shot {crop.shotIndex + 1}/{plan.shots.length} · {crop.shot?.reason ?? "—"}
            {crop.speakerTrack !== null ? ` · track ${crop.speakerTrack}` : ""} · <span className="text-faint">{plan.speaker_evidence}</span>
          </span>
        ) : (
          <span className="text-faint">{planQ.isLoading ? "loading reframe plan…" : "no reframe plan"}</span>
        )}
        {heldShot ? <span className="shrink-0 text-faint">Held frame</span> : null}
        {stalePlan ? <StateBadge state="stale" label="plan cuts differ" className="ml-auto" /> : null}
      </div>
      <div className="relative min-h-0 flex-1">
        <VideoBox
          ref={setSourceEl}
          src={sourceSrc}
          label="Source video with crop overlay"
          boxClassName="absolute inset-0 rounded border border-line"
          onStatus={(s) => setSourceStatus(s)}
          onClick={() => clock.toggle()}
          errorAction={proxyBtn}
          emptyContent={<p className="text-sm text-muted">No source media (run ingest).</p>}
        >
          {plan && crop ? <CropOverlay plan={plan} crop={crop} contentW={sourceEl?.videoWidth || undefined} contentH={sourceEl?.videoHeight || undefined} /> : null}
        </VideoBox>
      </div>
    </div>
  );

  const main = (
    <div className={cn("flex flex-col gap-3 p-3 sm:p-4", wide && "h-full min-h-0")}>
      <div ref={setRowEl} className={cn("flex gap-3", wide ? "min-h-0 flex-1" : "h-[440px] shrink-0")}>
        {left}
        {center}
      </div>
      <div className="shrink-0 space-y-3 rounded border border-line bg-panel p-3">
        <Transport clock={clock} cs={cs} fps={fps} frames={plan?.frames ?? Math.round(dur * fps)} frame={frame} />
        <ClipTimeline duration={dur} fps={fps} t={cs.t} plan={plan} events={capQ.data?.events ?? []} cutIn={c.cut_in} cutOut={c.cut_out} onSeek={(t) => clock.seek(t)} />
      </div>
    </div>
  );

  const side = (
    <div className="flex h-full min-h-0 flex-col border-line bg-panel max-xl:rounded max-xl:border xl:border-l">
      <StudioSidePanel
        c={c}
        jobId={job.id}
        plan={plan}
        planLoading={planQ.isLoading}
        planError={planQ.error}
        events={capQ.data?.events ?? []}
        captionsUrl={capQ.data?.url ?? c.render.captions_url}
        capLoading={capQ.isLoading}
        capError={capQ.error}
        t={cs.t}
        frame={frame}
        fps={fps}
        onSeek={(t) => clock.seek(t)}
      />
    </div>
  );

  return (
    <>
      {wide ? (
        <PanelGroup direction="horizontal" autoSaveId="studio-split" className="min-h-0 flex-1">
          <Panel defaultSize={70} minSize={50}>
            {main}
          </Panel>
          <ResizeHandle />
          <Panel defaultSize={30} minSize={22}>
            {side}
          </Panel>
        </PanelGroup>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto">
          {main}
          <div className="h-[560px] px-3 pb-4 sm:px-4">{side}</div>
        </div>
      )}
    </>
  );
}

function Studio({ job, c, cands }: { job: JobDetail; c: Candidate; cands: Candidate[] }) {
  const defaults = useDefaults();
  const actions = useRunAction(job.id);
  const [editing, setEditing] = useState(false);
  const editsQ = useEdits(job.id, c.id, editing);
  const editor = useEditor(job.id, c.id, editsQ.data);
  const planQ = useReframe(job.id, c.id, c.reframe.state !== "missing");
  const plan = planQ.data ?? null;
  const fps = (plan ? parseRate(plan.fps) : null) ?? job.fps ?? 30;
  const runClip = (a: "reframe" | "render", fast?: boolean) =>
    actions.run(a === "reframe" ? { action: "reframe", clips: [c.id], force: true, preview: defaults.previewReframes } : { action: "render", clips: [c.id], force: true, fast: !!fast });

  // Leaving the page with unsaved edits: the draft is kept in memory for this tab; warn on reload/close.
  useEffect(() => {
    if (!editor.dirty) return;
    const h = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", h);
    return () => window.removeEventListener("beforeunload", h);
  }, [editor.dirty]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <Header job={job} c={c} cands={cands} onRun={runClip} pending={actions.pending} editing={editing} onToggleEdit={() => setEditing((v) => !v)} dirty={editor.dirty} />
      {!editing ? (
        <ReviewStudio job={job} c={c} cands={cands} actions={actions} />
      ) : editsQ.isError ? (
        <ErrorState error={editsQ.error} onRetry={() => void editsQ.refetch()} className="py-16" />
      ) : !editsQ.data || !editor.draft || planQ.isLoading ? (
        <SkeletonRows rows={6} className="p-6" />
      ) : (
        <EditStudio job={job} c={c} ctx={editsQ.data} editor={editor} plan={plan} fps={fps} />
      )}
      <PaidConfirmDialog jobId={job.id} request={actions.paid} onClose={() => actions.setPaid(null)} />
    </div>
  );
}

export default function StudioPage() {
  const { job } = useJobContext();
  const { cid = "" } = useParams();
  const sel = useSelection(job.id);
  if (sel.isLoading) return <SkeletonRows rows={6} className="p-6" />;
  if (sel.isError) {
    if (sel.error instanceof ApiError && sel.error.status === 404) {
      return (
        <EmptyState icon={ListChecks} title="No clips yet" className="py-20">
          Run clip selection first.
        </EmptyState>
      );
    }
    return <ErrorState error={sel.error} onRetry={() => void sel.refetch()} className="py-20" />;
  }
  const cands = sel.data?.candidates ?? [];
  const c = cands.find((x) => x.id === cid);
  if (!c) {
    return (
      <EmptyState
        icon={ListChecks}
        title={`Clip ${cid} not found`}
        className="py-20"
        action={
          <Link to={`/jobs/${job.id}/clips`} className="press inline-flex h-8 items-center rounded border border-line px-3 text-sm text-fg hover:bg-fg/[0.05]">
            Back to clips
          </Link>
        }
      >
        It is not in candidates.json (it may have been replaced by a new selection).
      </EmptyState>
    );
  }
  return <Studio key={c.id} job={job} c={c} cands={cands} />;
}
