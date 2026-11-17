import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Panel, PanelGroup } from "react-resizable-panels";
import { ApiError } from "@/api/client";
import { useResetEdits, useSaveEdits } from "@/api/hooks";
import type { Candidate, EditContext, Edits, JobDetail, ReframePlan, Shot } from "@/api/types";
import { VideoBox, type MediaStatus } from "@/components/media/VideoBox";
import { Button } from "@/components/ui/Button";
import { ResizeHandle } from "@/components/ui/ResizeHandle";
import { PaidConfirmDialog } from "@/features/job/PaidConfirmDialog";
import { useRunAction } from "@/features/job/useRunAction";
import type { PWord } from "@/lib/captionPreview";
import { ClipClock } from "@/lib/clipClock";
import { cn } from "@/lib/cn";
import { LAYOUT_COLOR } from "@/lib/crop";
import {
  autoShots,
  clipRange,
  editForShot,
  effectiveCrop,
  LAYOUT_LABEL,
  seedShotEdit,
  shotKeyTime,
  shotRange,
  snap,
  snapPoints,
  stepWord,
  type EditLayout,
} from "@/lib/editing";
import { useHotkeys } from "@/lib/hotkeys";
import { isActive } from "@/lib/stages";
import { toast } from "@/lib/toast";
import { useElementSize } from "@/lib/useNow";
import { useMediaQuery } from "@/lib/useMediaQuery";
import { ClipTimeline } from "../ClipTimeline";
import { CropOverlay } from "../CropOverlay";
import { LiveCropCanvas } from "../LiveCropCanvas";
import { Transport } from "../Transport";
import { CaptionOverlay } from "./CaptionOverlay";
import { CropEditor } from "./CropEditor";
import { EditFooter } from "./EditFooter";
import { EditTools, type Tool, type TrimApi } from "./EditTools";
import type { Editor } from "./useEditor";

const PAD_S = 10; // seconds of context either side of the clip (the server sends words for ±10 s)

/** Studio in Edit mode (UI_SPEC 5b): the source is the clock, the 9:16 view is a live canvas with captions. */
export function EditStudio({ job, c, ctx, editor, plan, fps }: { job: JobDetail; c: Candidate; ctx: EditContext; editor: Editor; plan: ReframePlan | null; fps: number }) {
  const wide = useMediaQuery("(min-width: 1280px)");
  const draft = editor.draft as Edits; // caller renders this only with a draft
  const save = useSaveEdits(job.id, c.id);
  const reset = useResetEdits(job.id, c.id);
  const actions = useRunAction(job.id);
  const busy = isActive(job.active_run);
  const [tool, setTool] = useState<Tool>("trim");
  const [selected, setSelected] = useState<number | null>(null);

  // Fixed editing window around the saved cut (recomputed only when the saved edits change).
  const saved = clipRange(ctx, ctx.edits);
  const srcDur = ctx.limits.source_duration;
  const ws = Math.max(0, Math.min(saved.cutIn, ctx.original.cut_in) - PAD_S);
  const we = Math.min(srcDur, Math.max(saved.cutOut, ctx.original.cut_out) + PAD_S);
  const clock = useMemo(() => new ClipClock(ws, we - ws, fps), [ws, we, fps]);
  useEffect(() => () => clock.destroy(), [clock]);
  const cs = useSyncExternalStore(clock.subscribe, clock.getSnapshot, clock.getSnapshot);

  const [sourceEl, setSourceEl] = useState<HTMLVideoElement | null>(null);
  const [sourceStatus, setSourceStatus] = useState<MediaStatus>("none");
  useEffect(() => {
    clock.setSource(sourceEl, sourceStatus === "ready");
    return () => clock.setSource(null, false);
  }, [clock, sourceEl, sourceStatus]);

  const { cutIn, cutOut } = clipRange(ctx, draft);
  useEffect(() => {
    clock.setRange([cutIn - ws, cutOut - ws]);
  }, [clock, cutIn, cutOut, ws]);
  useEffect(() => {
    clock.seek(saved.cutIn - ws + 0.5 / fps);
    // only when the clock is (re)created
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clock]);

  const sourceT = cs.sourceT;
  const shots = draft.shots;
  const live = cs.sourceLive;
  const auto = useMemo(() => (plan ? autoShots(plan) : []), [plan]);

  // Held-frame edge shots: the source parks on the held frame while the clock runs (as the render does).
  const heldFrameAt = useCallback(
    (src: number): number | null => {
      if (!plan) return null;
      const pf = plan.frames / Math.max(1e-6, plan.duration);
      const f = Math.floor((src - plan.cut_in) * pf + 1e-6);
      const s = auto.find((x) => f >= x.f0 && f < x.f1);
      return s && s.hold_frame !== undefined && s.hold_frame !== null ? f : null;
    },
    [plan, auto],
  );
  useEffect(() => {
    if (!plan) return;
    const pf = plan.frames / Math.max(1e-6, plan.duration);
    clock.setHold((t) => {
      const f = heldFrameAt(ws + t);
      if (f === null) return null;
      const s = auto.find((x) => f >= x.f0 && f < x.f1);
      return s && s.hold_frame !== undefined && s.hold_frame !== null ? plan.cut_in + (s.hold_frame + 0.5) / pf : null;
    });
    return () => clock.setHold(null);
  }, [clock, plan, auto, ws, heldFrameAt]);
  const clockSrc = ws + cs.t; // where the clip clock is (sourceT can sit on a held frame)
  const heldF = heldFrameAt(clockSrc);
  const eff = plan ? effectiveCrop(plan, shots, sourceT, heldF !== null ? { frame: heldF } : { presented: live }) : null;

  // ---------------------------------------------------------------- trim
  const pts = useMemo(() => snapPoints(ctx.words), [ctx.words]);
  const minS = ctx.limits.min_s;
  const maxS = ctx.limits.max_s;
  const setTrim = useCallback(
    (a: number, b: number) =>
      editor.update((e) => {
        const r = { cut_in: Math.round(a * 1000) / 1000, cut_out: Math.round(b * 1000) / 1000 };
        const same = Math.abs(r.cut_in - ctx.original.cut_in) < 5e-4 && Math.abs(r.cut_out - ctx.original.cut_out) < 5e-4;
        return { ...e, trim: same ? null : r };
      }, "trim"),
    [editor, ctx.original.cut_in, ctx.original.cut_out],
  );
  const setEdge = (which: "in" | "out", t: number, noSnap = false) => {
    const v0 = Math.min(we, Math.max(ws, noSnap ? t : snap(t, pts)));
    if (which === "in") setTrim(Math.min(v0, cutOut - minS), cutOut);
    else setTrim(cutIn, Math.max(v0, cutIn + minS));
  };
  const nudge = (which: "in" | "out", unit: "frame" | "word", dir: 1 | -1) => {
    const cur = which === "in" ? cutIn : cutOut;
    const next = unit === "frame" ? cur + dir / fps : stepWord(cur, pts, dir);
    setEdge(which, next, true);
    clock.seek(next - ws);
  };
  const len = cutOut - cutIn;
  const trimError = len < minS - 1e-6 ? `At least ${minS} s` : len > maxS + 1e-6 ? `At most ${maxS} s` : null;
  const trim: TrimApi = {
    cutIn,
    cutOut,
    setEdge,
    nudge,
    playRange: () => {
      clock.seek(cutIn - ws + 0.5 / fps);
      clock.play();
    },
    error: trimError,
  };

  // ---------------------------------------------------------------- framing
  const selectShot = (i: number) => {
    setSelected(i);
    setTool("framing");
    if (!plan) return;
    const [a, b] = shotRange(plan, auto[i]);
    const inside = Math.max(a, cutIn);
    const now = ws + clock.getSnapshot().t;
    if (now < inside || now >= Math.min(b, cutOut)) clock.seek(inside + 0.5 / fps - ws);
  };
  const setLayout = (i: number, layout: EditLayout) => {
    if (!plan) return;
    const s = auto[i];
    const at = shotKeyTime(plan, s, cutIn, cutOut);
    const [a, b] = shotRange(plan, s);
    const mid = effectiveCrop(plan, [], Math.min(b - 0.01, Math.max(a, (a + b) / 2)));
    editor.update((e) => {
      const rest = e.shots.filter((x) => !(x.at >= a && x.at < b));
      return { ...e, shots: layout === "AUTO" ? rest : [...rest, seedShotEdit(plan, layout, at, mid)].sort((p, q) => p.at - q.at) };
    });
    selectShot(i);
  };
  const selEdit = plan && selected !== null && auto[selected] ? editForShot(plan, auto[selected], shots) : null;
  const dragging = tool === "framing" && !!eff && selected !== null && eff.shotIndex === selected && (selEdit?.layout === "FIXED" || selEdit?.layout === "GROUP");
  const onCropDrag = (r: { x: number; y: number; w: number; h: number }) => {
    if (!plan || selected === null || !selEdit) return;
    const [a, b] = shotRange(plan, auto[selected]);
    editor.update(
      (e) => ({
        ...e,
        shots: e.shots.map((x) =>
          x.at >= a && x.at < b
            ? x.layout === "FIXED"
              ? { ...x, x: Math.round(r.x) }
              : { ...x, crop: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.w * 1000) / 1000, h: Math.round(r.h) } }
            : x,
        ),
      }),
      `crop-${selected}`,
    );
  };

  // ---------------------------------------------------------------- captions preview
  const previewWords: PWord[] = useMemo(
    () =>
      ctx.words
        .filter((w) => w.end > cutIn && w.start < cutOut && draft.words[String(w.i)] !== "")
        .map((w) => ({ i: w.i, w: draft.words[String(w.i)] ?? w.w, start: w.start - cutIn, end: w.end - cutIn })),
    [ctx.words, cutIn, cutOut, draft.words],
  );
  const layoutAt = useCallback((tt: number): Shot["layout"] | null => (plan ? effectiveCrop(plan, shots, cutIn + tt).layout : null), [plan, shots, cutIn]);

  // ---------------------------------------------------------------- save / render
  const doSave = () => {
    if (trimError || !editor.dirty) return;
    save.mutate(draft, {
      onSuccess: () => toast({ tone: "success", title: "Edits saved", description: `${c.id} · render to apply` }),
      onError: (e) => toast({ tone: "error", title: "Could not save", description: e instanceof ApiError ? `${e.message} (${e.code})` : String(e) }),
    });
  };
  const doRender = (fast: boolean, withReframe: boolean) =>
    actions.run(withReframe ? { action: "produce", clips: [c.id], fast } : { action: "render", clips: [c.id], fast, force: true });

  useHotkeys({
    space: () => clock.toggle(),
    arrowright: (e) => (e.shiftKey ? clock.seek(clock.getSnapshot().t + 1) : clock.step(1)),
    arrowleft: (e) => (e.shiftKey ? clock.seek(clock.getSnapshot().t - 1) : clock.step(-1)),
    i: () => setEdge("in", ws + clock.getSnapshot().t),
    o: () => setEdge("out", ws + clock.getSnapshot().t),
    home: () => clock.seek(cutIn - ws + 0.5 / fps),
    end: () => clock.seek(cutOut - ws - 0.5 / fps),
    l: () => clock.setLoop(!cs.loop),
    m: () => clock.setMuted(!cs.muted),
    "mod+z": () => editor.undo(),
    "mod+shift+z": () => editor.redo(),
    "mod+y": () => editor.redo(),
    "mod+s": () => doSave(),
  });

  // ---------------------------------------------------------------- layout
  const sm = job.source_media;
  const sourceSrc = sm ? (sm.proxy_url ?? sm.url) : null;
  const [rowEl, setRowEl] = useState<HTMLDivElement | null>(null);
  const row = useElementSize(rowEl);
  const leftW = Math.max(160, Math.min((row.height - 32) * (9 / 16), row.width * 0.42));
  const tlPlan = plan ? { ...plan, shots: auto } : null;

  const left = (
    <div className="flex h-full shrink-0 flex-col gap-2" style={{ width: leftW }}>
      <div className="flex h-7 items-center text-xs text-muted">Preview</div>
      <div className="relative min-h-0 flex-1 overflow-hidden rounded border border-line bg-black">
        {plan && eff ? <LiveCropCanvas video={sourceStatus === "ready" ? sourceEl : null} plan={plan} crop={eff} frameKey={sourceT} /> : null}
        <CaptionOverlay words={previewWords} t={clockSrc - cutIn} clipDur={len} layoutAt={layoutAt} captions={draft.captions} hook={draft.hook} />
        {clockSrc < cutIn - 0.5 / fps || clockSrc >= cutOut ? <div className="absolute inset-0 bg-black/60" aria-hidden /> : null}
        {!plan ? <div className="absolute inset-0 flex items-center justify-center p-4 text-center text-xs text-muted">Run Reframe to preview the framing.</div> : null}
      </div>
    </div>
  );

  const center = (
    <div className="flex h-full min-w-0 flex-1 flex-col gap-2">
      <div className="flex h-7 min-w-0 items-center gap-2 overflow-hidden text-xs">
        <span className="shrink-0 text-muted">Source</span>
        {eff && !eff.outside ? (
          <span className="shrink-0 rounded-sm px-1.5 py-0.5 font-mono" style={{ color: eff.edited ? "rgb(var(--accent))" : eff.layout ? LAYOUT_COLOR[eff.layout] : undefined, background: "rgb(var(--raised))" }}>
            {eff.label}
          </span>
        ) : null}
        {eff?.outside ? <span className="text-faint">Not analysed yet</span> : null}
        {eff?.held ? <span className="text-faint">Held frame</span> : null}
      </div>
      <div className="relative min-h-0 flex-1">
        <VideoBox
          ref={setSourceEl}
          src={sourceSrc}
          label="Source video for editing"
          boxClassName="absolute inset-0 rounded border border-line"
          onStatus={(s) => setSourceStatus(s)}
          onClick={() => (dragging ? undefined : clock.toggle())}
          emptyContent={<p className="text-sm text-muted">No source media.</p>}
          errorAction={
            sm && !sm.proxy_url ? (
              <Button size="sm" variant="primary" disabled={busy} onClick={() => actions.run({ action: "proxy" })}>
                Make preview copy (free)
              </Button>
            ) : null
          }
        >
          {plan && eff && !eff.outside ? (
            dragging && eff.rects[0] ? (
              <>
                <CropOverlay plan={plan} crop={eff} contentW={sourceEl?.videoWidth || undefined} contentH={sourceEl?.videoHeight || undefined} />
                <CropEditor plan={plan} rect={eff.rects[0]} mode={selEdit!.layout as "FIXED" | "GROUP"} contentW={sourceEl?.videoWidth || undefined} contentH={sourceEl?.videoHeight || undefined} onChange={onCropDrag} />
              </>
            ) : (
              <CropOverlay plan={plan} crop={eff} contentW={sourceEl?.videoWidth || undefined} contentH={sourceEl?.videoHeight || undefined} />
            )
          ) : null}
        </VideoBox>
      </div>
    </div>
  );

  const tlEdit = {
    trimIn: cutIn - ws,
    trimOut: cutOut - ws,
    onTrim: (which: "in" | "out", t: number, noSnap: boolean) => setEdge(which, ws + t, noSnap),
    words: ctx.words.map((w) => {
      const v = draft.words[String(w.i)];
      return { start: w.start - ws, end: w.end - ws, hidden: v === "", edited: v !== undefined && v !== "" };
    }),
    selectedShot: selected,
    onSelectShot: selectShot,
    shotLabel: (i: number) => {
      const s = auto[i];
      const e = plan && s ? editForShot(plan, s, shots) : null;
      return e && e.layout !== "AUTO" ? { text: LAYOUT_LABEL[e.layout], edited: true } : { text: s ? LAYOUT_LABEL[s.layout] : "", edited: false };
    },
    hook: draft.hook.enabled && draft.hook.text.trim() ? ([cutIn - ws, Math.min(cutOut, cutIn + draft.hook.seconds) - ws] as [number, number]) : null,
  };

  const main = (
    <div className={cn("flex flex-col gap-3 p-3 sm:p-4", wide && "h-full min-h-0")}>
      <div ref={setRowEl} className={cn("flex gap-3", wide ? "min-h-0 flex-1" : "h-[440px] shrink-0")}>
        {left}
        {center}
      </div>
      <div className="shrink-0 space-y-3 rounded border border-line bg-panel p-3">
        <Transport clock={clock} cs={cs} fps={fps} frames={Math.round(len * fps)} frame={Math.max(0, Math.floor((clockSrc - cutIn) * fps + 1e-6))} range={[cutIn - ws, cutOut - ws]} />
        <ClipTimeline duration={we - ws} fps={fps} t={cs.t} plan={tlPlan} events={[]} origin={ws} cutIn={cutIn} cutOut={cutOut} onSeek={(t) => clock.seek(t)} edit={tlEdit} />
        <div className="border-t border-line pt-2.5">
          <EditFooter
            ctx={ctx}
            dirty={editor.dirty}
            canUndo={editor.canUndo}
            canRedo={editor.canRedo}
            onUndo={editor.undo}
            onRedo={editor.redo}
            onDiscard={editor.discard}
            onSave={doSave}
            saving={save.isPending}
            saveBlocked={trimError}
            busy={busy || actions.pending}
            onRender={doRender}
          />
        </div>
      </div>
    </div>
  );

  const side = (
    <div className="flex h-full min-h-0 flex-col border-line bg-panel max-xl:rounded max-xl:border xl:border-l">
      <EditTools
        tool={tool}
        onTool={setTool}
        ctx={ctx}
        editor={editor}
        trim={trim}
        framing={{ plan, selected, select: selectShot, setLayout, clipIn: cutIn, clipOut: cutOut }}
        onSeek={(st) => clock.seek(st - ws)}
        resetting={reset.isPending}
        onResetAll={() =>
          reset.mutate(undefined, {
            onSuccess: () => toast({ tone: "success", title: "Clip reset to automatic", description: c.id }),
            onError: (e) => toast({ tone: "error", title: "Could not reset", description: e instanceof ApiError ? `${e.message} (${e.code})` : String(e) }),
          })
        }
      />
    </div>
  );

  return (
    <>
      {wide ? (
        <PanelGroup direction="horizontal" autoSaveId="studio-edit-split" className="min-h-0 flex-1">
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
      <PaidConfirmDialog jobId={job.id} request={actions.paid} onClose={() => actions.setPaid(null)} />
    </>
  );
}
