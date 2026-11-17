import { ChevronsLeft, ChevronsRight, Play, StepBack, StepForward } from "lucide-react";
import { useId, useMemo, useState, type ReactNode } from "react";
import type { EditContext, Edits, ReframePlan, ShotEdit } from "@/api/types";
import { Button, IconButton } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Kbd } from "@/components/ui/Kbd";
import { Switch } from "@/components/ui/Misc";
import { Segmented } from "@/components/ui/Segmented";
import { TabsContent, TabsList, TabsRoot, TabsTrigger } from "@/components/ui/Tabs";
import { cn } from "@/lib/cn";
import { autoShots, editForShot, LAYOUT_LABEL, shotRange, type EditLayout } from "@/lib/editing";
import { fmtClock } from "@/lib/format";
import type { Editor } from "./useEditor";

export type Tool = "trim" | "framing" | "captions" | "hook" | "title";

const inputCls = "h-8 w-full rounded border border-line bg-bg px-2.5 text-sm text-fg placeholder:text-faint focus:border-accent/70 focus:outline-none";

function Row({ label, children, htmlFor }: { label: string; children: ReactNode; htmlFor?: string }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <label htmlFor={htmlFor} className="shrink-0 text-sm text-muted">
        {label}
      </label>
      {children}
    </div>
  );
}

// ---------------------------------------------------------------- Trim

export interface TrimApi {
  cutIn: number;
  cutOut: number;
  setEdge: (which: "in" | "out", t: number, noSnap?: boolean) => void;
  nudge: (which: "in" | "out", unit: "frame" | "word", dir: 1 | -1) => void;
  playRange: () => void;
  error: string | null;
}

function TrimTool({ ctx, draft, editor, trim }: { ctx: EditContext; draft: Edits; editor: Editor; trim: TrimApi }) {
  const edge = (which: "in" | "out") => {
    const v = which === "in" ? trim.cutIn : trim.cutOut;
    return (
      <div className="space-y-1.5">
        <div className="flex items-baseline justify-between">
          <span className="text-sm text-muted">{which === "in" ? "In" : "Out"}</span>
          <span className="font-mono text-sm text-fg tnum">{fmtClock(v, { ms: true })}</span>
        </div>
        <div className="flex items-center gap-0.5">
          <IconButton size="sm" label={`${which === "in" ? "In" : "Out"}: one word earlier`} onClick={() => trim.nudge(which, "word", -1)}>
            <ChevronsLeft className="size-4" aria-hidden />
          </IconButton>
          <IconButton size="sm" label={`${which === "in" ? "In" : "Out"}: one frame earlier`} onClick={() => trim.nudge(which, "frame", -1)}>
            <StepBack className="size-3.5" aria-hidden />
          </IconButton>
          <IconButton size="sm" label={`${which === "in" ? "In" : "Out"}: one frame later`} onClick={() => trim.nudge(which, "frame", 1)}>
            <StepForward className="size-3.5" aria-hidden />
          </IconButton>
          <IconButton size="sm" label={`${which === "in" ? "In" : "Out"}: one word later`} onClick={() => trim.nudge(which, "word", 1)}>
            <ChevronsRight className="size-4" aria-hidden />
          </IconButton>
          <span className="ml-auto text-xs text-faint">
            <Kbd>{which === "in" ? "I" : "O"}</Kbd> at playhead
          </span>
        </div>
      </div>
    );
  };
  const len = trim.cutOut - trim.cutIn;
  return (
    <div className="space-y-4 p-4">
      {edge("in")}
      {edge("out")}
      <div className="flex items-center justify-between border-t border-line pt-3">
        <span className="text-sm text-muted">Length</span>
        <span className={cn("font-mono text-sm tnum", trim.error ? "text-bad" : "text-fg")}>{(Math.floor(len * 100 + 1e-6) / 100).toFixed(2)} s</span>
      </div>
      {trim.error ? <p className="text-xs text-bad">{trim.error}</p> : null}
      <div className="flex items-center justify-between gap-2">
        <Button size="sm" icon={<Play className="size-3.5" aria-hidden />} onClick={trim.playRange}>
          Play trimmed
        </Button>
        {draft.trim ? (
          <button type="button" className="text-xs text-muted hover:text-fg" onClick={() => editor.update((e) => ({ ...e, trim: null }), "trim")}>
            Back to {fmtClock(ctx.original.cut_in)}–{fmtClock(ctx.original.cut_out)}
          </button>
        ) : null}
      </div>
      <p className="text-xs text-faint">Drag the handles on the timeline. Edges snap to gaps between words; hold Alt to place freely.</p>
    </div>
  );
}

// ---------------------------------------------------------------- Framing

export interface FramingApi {
  plan: ReframePlan | null;
  selected: number | null;
  select: (i: number) => void;
  setLayout: (i: number, layout: EditLayout) => void;
  clipIn: number;
  clipOut: number;
}

const LAYOUT_OPTS: EditLayout[] = ["AUTO", "TRACK", "FIXED", "GROUP", "SPLIT", "FIT"];

function FramingTool({ draft, f }: { draft: Edits; f: FramingApi }) {
  const plan = f.plan;
  if (!plan) {
    return <p className="p-4 text-sm text-muted">This clip has no reframe plan yet. Run Reframe first.</p>;
  }
  const shots = autoShots(plan);
  const sel = f.selected !== null ? shots[f.selected] : null;
  const e: ShotEdit | null = sel ? editForShot(plan, sel, draft.shots) : null;
  const cur: EditLayout = e?.layout ?? "AUTO";
  return (
    <div className="space-y-4 p-4">
      <ol className="space-y-1" aria-label="Shots">
        {shots.map((s, i) => {
          const [a, b] = shotRange(plan, s);
          if (b <= f.clipIn || a >= f.clipOut) return null;
          const se = editForShot(plan, s, draft.shots);
          const on = f.selected === i;
          return (
            <li key={i}>
              <button
                type="button"
                onClick={() => f.select(i)}
                aria-current={on ? "true" : undefined}
                className={cn("row-hover flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm", on && "bg-accent/[0.08] shadow-[inset_2px_0_0_rgb(var(--accent))]")}
              >
                <span className="w-5 font-mono text-xs text-faint">{i + 1}</span>
                <span className="font-mono text-xs text-muted tnum">{fmtClock(Math.max(a, f.clipIn) - f.clipIn, { ms: true })}</span>
                <span className={cn("ml-auto", se && se.layout !== "AUTO" ? "text-accent" : "text-muted")}>
                  {se && se.layout !== "AUTO" ? LAYOUT_LABEL[se.layout] : `Auto · ${LAYOUT_LABEL[s.layout]}`}
                </span>
              </button>
            </li>
          );
        })}
      </ol>
      {sel && f.selected !== null ? (
        <div className="space-y-2 border-t border-line pt-3">
          <div className="text-sm text-muted">Shot {f.selected + 1}</div>
          <div className="flex flex-wrap gap-1">
            {LAYOUT_OPTS.map((l) => {
              const disabled = l === "SPLIT" && sel.layout !== "SPLIT";
              return (
                <button
                  key={l}
                  type="button"
                  disabled={disabled}
                  aria-pressed={cur === l}
                  title={disabled ? "Split needs two faces apart; the automatic plan did not find them in this shot" : undefined}
                  onClick={() => f.setLayout(f.selected!, l)}
                  className={cn(
                    "press h-7 rounded-sm border px-2 text-sm disabled:pointer-events-none disabled:opacity-35",
                    cur === l ? "border-accent/60 bg-accent/10 text-fg" : "border-line text-muted hover:text-fg",
                  )}
                >
                  {LAYOUT_LABEL[l]}
                </button>
              );
            })}
          </div>
          {cur === "FIXED" || cur === "GROUP" ? <p className="text-xs text-faint">Drag the box on the source view{cur === "GROUP" ? "; corners resize it" : ""}.</p> : null}
        </div>
      ) : (
        <p className="text-xs text-faint">Pick a shot here or on the timeline.</p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- Captions

/**
 * Text field for one caption word. Non-empty text applies live; an empty field is only a typing state (it never
 * hides the word or locks the field — "Hide word" does that). Enter applies, Escape restores the saved text.
 */
function WordField({ id, original, value, onCommit }: { id: string; original: string; value: string | undefined; onCommit: (v: string | undefined) => void }) {
  const hidden = value === "";
  const stored = value ?? original;
  const [text, setText] = useState(stored);
  const [prevStored, setPrevStored] = useState(stored);
  if (stored !== prevStored) {
    // undo/redo or Restore changed the word from outside: follow it
    setPrevStored(stored);
    setText(stored);
  }
  const apply = (v: string) => {
    if (!v.trim()) return;
    onCommit(v === original ? undefined : v);
  };
  return (
    <input
      id={id}
      className={cn(inputCls, hidden && "opacity-50")}
      value={hidden ? "" : text}
      placeholder={hidden ? "Hidden" : original}
      disabled={hidden}
      spellCheck={false}
      autoComplete="off"
      onChange={(ev) => {
        setText(ev.target.value);
        apply(ev.target.value);
      }}
      onBlur={() => {
        if (!text.trim()) setText(stored);
      }}
      onKeyDown={(ev) => {
        if (ev.key === "Enter") {
          ev.preventDefault();
          if (text.trim()) apply(text.trim());
          else setText(stored);
        } else if (ev.key === "Escape" && text !== stored) {
          ev.preventDefault();
          ev.stopPropagation();
          setText(stored);
        }
      }}
    />
  );
}

function CaptionsTool({ ctx, draft, editor, clipIn, clipOut, onSeek }: { ctx: EditContext; draft: Edits; editor: Editor; clipIn: number; clipOut: number; onSeek: (sourceT: number) => void }) {
  const uid = useId();
  const [sel, setSel] = useState<number | null>(null);
  const words = useMemo(() => ctx.words.filter((w) => w.end > clipIn && w.start < clipOut), [ctx.words, clipIn, clipOut]);
  const c = draft.captions;
  const selWord = sel !== null ? ctx.words.find((w) => w.i === sel) : undefined;
  const setWord = (i: number, v: string | undefined) =>
    editor.update((e) => {
      const next = Object.fromEntries(Object.entries(e.words).filter(([k]) => k !== String(i)));
      if (v !== undefined) next[String(i)] = v;
      return { ...e, words: next };
    }, `word-${i}`);
  return (
    <div className="space-y-4 p-4">
      <Switch id={`${uid}-on`} checked={c.enabled} onChange={(v) => editor.update((e) => ({ ...e, captions: { ...e.captions, enabled: v } }))} label="Captions" />
      <div className={cn("space-y-3", !c.enabled && "pointer-events-none opacity-45")}>
        <Row label="Position">
          <Segmented<Edits["captions"]["position"]>
            size="sm"
            label="Caption position"
            value={c.position}
            onChange={(v) => editor.update((e) => ({ ...e, captions: { ...e.captions, position: v } }))}
            options={[
              { value: "auto", label: "Auto", title: "Follows the layout (lower for one face, the seam for split)" },
              { value: "upper", label: "Upper" },
              { value: "middle", label: "Middle" },
              { value: "lower", label: "Lower" },
            ]}
          />
        </Row>
        <Row label="Size" htmlFor={`${uid}-size`}>
          <div className="flex items-center gap-2">
            <input
              id={`${uid}-size`}
              type="range"
              min={64}
              max={110}
              step={2}
              value={c.size}
              onChange={(ev) => editor.update((e) => ({ ...e, captions: { ...e.captions, size: Number(ev.target.value) } }), "cap-size")}
              className="w-32 accent-[rgb(var(--accent))]"
            />
            <span className="w-8 text-right font-mono text-xs text-muted tnum">{c.size}</span>
          </div>
        </Row>
      </div>
      <div className="border-t border-line pt-3">
        <div className="mb-2 text-sm text-muted">Words</div>
        <p className="flex flex-wrap gap-x-1 gap-y-0.5 text-sm leading-relaxed">
          {words.map((w) => {
            const v = draft.words[String(w.i)];
            const hidden = v === "";
            const edited = v !== undefined && !hidden;
            return (
              <button
                key={w.i}
                type="button"
                onClick={() => {
                  setSel(w.i);
                  onSeek(w.start + 0.01);
                }}
                className={cn(
                  "rounded-sm px-0.5 hover:bg-fg/[0.07]",
                  sel === w.i && "bg-accent/15 text-fg",
                  hidden ? "text-faint line-through" : edited ? "text-accent underline decoration-accent/50 underline-offset-2" : "text-fg/85",
                )}
                title={edited ? `was “${w.w}”` : hidden ? "hidden" : undefined}
              >
                {edited ? v : w.w}
              </button>
            );
          })}
        </p>
        {selWord ? (
          <div className="mt-3 space-y-2 rounded border border-line bg-bg/50 p-3">
            <label htmlFor={`${uid}-word`} className="block text-xs text-muted">
              “{selWord.w}” at {fmtClock(selWord.start - clipIn, { ms: true })}
            </label>
            <WordField
              key={`${selWord.i}:${draft.words[String(selWord.i)] === "" ? "hidden" : "shown"}`}
              id={`${uid}-word`}
              original={selWord.w}
              value={draft.words[String(selWord.i)]}
              onCommit={(v) => setWord(selWord.i, v)}
            />
            <div className="flex items-center gap-3 text-xs">
              {draft.words[String(selWord.i)] === "" ? (
                <button type="button" className="text-accent hover:underline" onClick={() => setWord(selWord.i, undefined)}>
                  Show word
                </button>
              ) : (
                <button type="button" className="text-muted hover:text-fg" onClick={() => setWord(selWord.i, "")}>
                  Hide word
                </button>
              )}
              {draft.words[String(selWord.i)] !== undefined ? (
                <button type="button" className="ml-auto text-muted hover:text-fg" onClick={() => setWord(selWord.i, undefined)}>
                  Restore
                </button>
              ) : null}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- Hook / Title

/** Number field that lets you clear and retype; valid values (0.5–10 s) apply live, anything else reverts on blur. */
function SecondsField({ id, value, onCommit }: { id: string; value: number; onCommit: (n: number) => void }) {
  const [text, setText] = useState(String(value));
  const [prev, setPrev] = useState(value);
  if (value !== prev) {
    setPrev(value);
    if (Number(text) !== value) setText(String(value));
  }
  const valid = (v: string) => {
    const n = Number(v);
    return v.trim() !== "" && Number.isFinite(n) && n >= 0.5 && n <= 10 ? n : null;
  };
  const bad = valid(text) === null;
  return (
    <span className="flex items-center gap-1.5">
      <input
        id={id}
        type="number"
        inputMode="decimal"
        min={0.5}
        max={10}
        step={0.5}
        value={text}
        aria-invalid={bad || undefined}
        onChange={(ev) => {
          setText(ev.target.value);
          const n = valid(ev.target.value);
          if (n !== null) onCommit(n);
        }}
        onBlur={() => {
          if (bad) setText(String(value));
        }}
        className={cn(inputCls, "w-20 font-mono tnum", bad && "border-bad/70")}
      />
      <span className="text-xs text-faint">s</span>
    </span>
  );
}

function HookTool({ draft, editor }: { draft: Edits; editor: Editor }) {
  const uid = useId();
  const h = draft.hook;
  return (
    <div className="space-y-4 p-4">
      <Switch id={`${uid}-on`} checked={h.enabled} onChange={(v) => editor.update((e) => ({ ...e, hook: { ...e.hook, enabled: v } }))} label="On-screen hook" />
      <div className={cn("space-y-3", !h.enabled && "pointer-events-none opacity-45")}>
        <div>
          <label htmlFor={`${uid}-text`} className="mb-1.5 block text-sm text-muted">
            Text
          </label>
          <textarea
            id={`${uid}-text`}
            rows={3}
            value={h.text}
            onChange={(ev) => editor.update((e) => ({ ...e, hook: { ...e.hook, text: ev.target.value } }), "hook-text")}
            className={cn(inputCls, "h-auto resize-none py-2")}
          />
        </div>
        <Row label="Seconds" htmlFor={`${uid}-sec`}>
          <SecondsField id={`${uid}-sec`} value={h.seconds} onCommit={(n) => editor.update((e) => ({ ...e, hook: { ...e.hook, seconds: n } }), "hook-sec")} />
        </Row>
      </div>
    </div>
  );
}

function TitleTool({ ctx, draft, editor }: { ctx: EditContext; draft: Edits; editor: Editor }) {
  const uid = useId();
  return (
    <div className="space-y-2 p-4">
      <label htmlFor={`${uid}-title`} className="sr-only">
        Clip title
      </label>
      <input
        id={`${uid}-title`}
        className={inputCls}
        value={draft.title ?? ctx.original.title}
        onChange={(ev) => editor.update((e) => ({ ...e, title: ev.target.value === ctx.original.title ? null : ev.target.value }), "title")}
      />
      {draft.title !== null ? (
        <button type="button" className="text-xs text-muted hover:text-fg" onClick={() => editor.update((e) => ({ ...e, title: null }))}>
          Use the original title
        </button>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------- panel

export function EditTools({
  tool,
  onTool,
  ctx,
  editor,
  trim,
  framing,
  onSeek,
  onResetAll,
  resetting,
}: {
  tool: Tool;
  onTool: (t: Tool) => void;
  ctx: EditContext;
  editor: Editor;
  trim: TrimApi;
  framing: FramingApi;
  onSeek: (sourceT: number) => void;
  onResetAll: () => void;
  resetting: boolean;
}) {
  const [confirm, setConfirm] = useState(false);
  const draft = editor.draft;
  if (!draft) return null;
  return (
    <TabsRoot value={tool} onValueChange={(v) => onTool(v as Tool)} className="flex h-full min-h-0 flex-col">
      <TabsList label="Edit tools">
        <TabsTrigger value="trim">Trim</TabsTrigger>
        <TabsTrigger value="framing">Framing</TabsTrigger>
        <TabsTrigger value="captions">Captions</TabsTrigger>
        <TabsTrigger value="hook">Hook</TabsTrigger>
        <TabsTrigger value="title">Title</TabsTrigger>
      </TabsList>
      <TabsContent value="trim" className="overflow-y-auto">
        <TrimTool ctx={ctx} draft={draft} editor={editor} trim={trim} />
      </TabsContent>
      <TabsContent value="framing" className="overflow-y-auto">
        <FramingTool draft={draft} f={framing} />
      </TabsContent>
      <TabsContent value="captions" className="overflow-y-auto">
        <CaptionsTool ctx={ctx} draft={draft} editor={editor} clipIn={trim.cutIn} clipOut={trim.cutOut} onSeek={onSeek} />
      </TabsContent>
      <TabsContent value="hook" className="overflow-y-auto">
        <HookTool draft={draft} editor={editor} />
      </TabsContent>
      <TabsContent value="title" className="overflow-y-auto">
        <TitleTool ctx={ctx} draft={draft} editor={editor} />
      </TabsContent>
      <div className="shrink-0 border-t border-line px-4 py-2 text-right">
        <button type="button" disabled={resetting} onClick={() => setConfirm(true)} className="text-xs text-faint hover:text-fg disabled:opacity-50">
          Reset clip to automatic
        </button>
      </div>
      <ConfirmDialog open={confirm} onOpenChange={setConfirm} title="Reset this clip to automatic?" confirmLabel="Reset" tone="danger" onConfirm={onResetAll}>
        Removes every saved edit (trim, framing, captions, hook, title) and restores the selection’s cut and title. The clip then needs a new render.
      </ConfirmDialog>
    </TabsRoot>
  );
}
