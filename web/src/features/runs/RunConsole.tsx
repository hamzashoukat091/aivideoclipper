import { ArrowDownToLine, ChevronDown, ChevronRight, Download, Square, TerminalSquare, WrapText } from "lucide-react";
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useCancelRun } from "@/api/hooks";
import type { RunInfo, RunStep } from "@/api/types";
import { useRunStream } from "@/api/useRunStream";
import { Button, IconButton } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { EmptyState, InlineError, SkeletonRows } from "@/components/ui/Feedback";
import { CopyButton } from "@/components/ui/Misc";
import { StateBadge, StateIcon } from "@/components/ui/Status";
import { Tooltip } from "@/components/ui/Tooltip";
import { cn } from "@/lib/cn";
import { elapsedSeconds, fmtClock, fmtDateTime } from "@/lib/format";
import { setDefaults, useDefaults } from "@/lib/settings";
import { ACTION_LABEL, isActive } from "@/lib/stages";
import { toast } from "@/lib/toast";
import { useNow } from "@/lib/useNow";

const RENDER_LIMIT = 2000;

function lineClass(l: string): string {
  if (l.startsWith("$ ")) return "text-accent";
  if (/^\[exit 0\b/.test(l)) return "text-ok";
  if (/^\[exit -?\d+/.test(l)) return /^\[exit 2\b/.test(l) ? "text-warn" : "text-bad";
  if (/^\[cancel/i.test(l)) return "text-warn";
  if (/traceback|error|exception|failed|fatal/i.test(l)) return "text-bad";
  if (/warn|skip/i.test(l)) return "text-warn";
  if (/^=== |^\d+\/\d+ /.test(l)) return "text-fg font-medium";
  return "text-muted";
}

const LogLines = memo(function LogLines({ lines, wrap }: { lines: string[]; wrap: boolean }) {
  return (
    <>
      {lines.map((l, i) => (
        <div key={i} className={cn("min-h-[18px] px-3", wrap ? "whitespace-pre-wrap break-all" : "whitespace-pre", lineClass(l))}>
          {l || " "}
        </div>
      ))}
    </>
  );
});

function StepRow({ step, now }: { step: RunStep; now: number }) {
  const [open, setOpen] = useState(false);
  const el = elapsedSeconds(step.started, step.ended, now);
  const cmd = step.command.join(" ");
  return (
    <li className="border-b border-line/60 last:border-b-0">
      <div className="flex items-center gap-2 px-3 py-1.5">
        <StateIcon state={step.state} />
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          className="press flex min-w-0 flex-1 items-center gap-1.5 rounded text-left text-sm text-fg"
        >
          {open ? <ChevronDown className="size-3.5 shrink-0 text-faint" aria-hidden /> : <ChevronRight className="size-3.5 shrink-0 text-faint" aria-hidden />}
          <span className="shrink-0 font-medium">{step.name}</span>
          <span className="min-w-0 truncate font-mono text-xs text-faint" title={cmd}>
            {cmd}
          </span>
        </button>
        {step.exit_code !== null ? (
          <span className={cn("shrink-0 font-mono text-xs tnum", step.exit_code === 0 ? "text-ok" : step.exit_code === 2 && step.name === "diarize" ? "text-warn" : "text-bad")}>
            exit {step.exit_code}
          </span>
        ) : null}
        <span className="w-14 shrink-0 text-right font-mono text-xs text-muted tnum">{el === null ? (step.state === "skipped" ? "skip" : "—") : fmtClock(el)}</span>
      </div>
      {open ? (
        <div className="flex items-start gap-2 bg-bg/60 px-3 py-2">
          <code className="min-w-0 flex-1 whitespace-pre-wrap break-all font-mono text-xs text-fg">$ {cmd}</code>
          <CopyButton text={cmd} label="Copy command" />
        </div>
      ) : null}
    </li>
  );
}

export function RunConsole({ run, className, emptyHint, title = "Run console" }: { run: RunInfo | null; className?: string; emptyHint?: string; title?: string }) {
  const { lines, run: live, connection, loading, error } = useRunStream(run);
  const defaults = useDefaults();
  const [auto, setAuto] = useState(defaults.autoScrollLogs);
  const [wrap, setWrap] = useState(true);
  const [showAll, setShowAll] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const cancel = useCancelRun();
  const scroller = useRef<HTMLDivElement>(null);
  const r = live;
  const active = isActive(r);
  const now = useNow(1000, active);

  const visible = useMemo(() => (showAll || lines.length <= RENDER_LIMIT ? lines : lines.slice(lines.length - RENDER_LIMIT)), [lines, showAll]);

  useLayoutEffect(() => {
    if (!auto) return;
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [visible, auto]);

  useEffect(() => setShowAll(false), [run?.id]);

  if (!r) {
    return (
      <section aria-label={title} className={cn("flex flex-col rounded border border-line bg-panel", className)}>
        <header className="flex h-10 items-center gap-2 border-b border-line px-3 text-sm font-medium text-fg">
          <TerminalSquare className="size-4 text-muted" aria-hidden /> {title}
        </header>
        <EmptyState icon={TerminalSquare} title="No runs yet" className="flex-1">
          {emptyHint ?? "Start a stage and its exact commands and live log will stream here."}
        </EmptyState>
      </section>
    );
  }

  const el = elapsedSeconds(r.started ?? r.created, r.ended, now);
  const text = lines.join("\n");
  const download = () => {
    const blob = new Blob([text + "\n"], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${r.job_id}-${r.id}.log`;
    a.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  return (
    <section aria-label={title} className={cn("flex min-h-0 flex-col overflow-hidden rounded border border-line bg-panel", className)}>
      <header className="flex min-h-10 flex-wrap items-center gap-x-2 gap-y-1 border-b border-line px-3 py-1.5">
        <TerminalSquare className="size-4 shrink-0 text-muted" aria-hidden />
        <span className="text-sm font-medium text-fg">{ACTION_LABEL[r.action]}</span>
        <StateBadge state={r.state} />
        <Tooltip content={`Created ${fmtDateTime(r.created)}`}>
          <span tabIndex={0} className="truncate font-mono text-xs text-faint">
            {r.id}
          </span>
        </Tooltip>
        <span className="font-mono text-xs text-muted tnum">{fmtClock(el)}</span>
        {connection !== "static" ? (
          <span className={cn("inline-flex items-center gap-1 text-xs", connection === "open" ? "text-run" : "text-warn")} aria-live="polite">
            <span className={cn("size-1.5 rounded-full", connection === "open" ? "animate-pulse-dot bg-run" : "bg-warn")} aria-hidden />
            {connection === "open" ? "live" : connection === "retrying" ? "reconnecting…" : connection}
          </span>
        ) : null}
        <div className="ml-auto flex items-center gap-0.5">
          {active ? (
            <Button size="sm" variant="danger" icon={<Square className="size-3" aria-hidden />} loading={cancel.isPending} onClick={() => setConfirmCancel(true)}>
              Cancel
            </Button>
          ) : null}
        </div>
      </header>
      {r.error ? (
        <div role="alert" className="m-2 rounded border border-bad/30 bg-bad/[0.07] px-3 py-1.5 text-sm text-bad">
          {r.error}
        </div>
      ) : null}
      {r.steps.length ? (
        <ol aria-label="Steps" className="max-h-48 shrink-0 overflow-y-auto border-b border-line">
          {r.steps.map((s, i) => (
            <StepRow key={`${s.name}-${i}`} step={s} now={now} />
          ))}
        </ol>
      ) : null}
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-line px-2">
        <span className="px-1 text-xs text-muted tnum">{lines.length.toLocaleString()} lines</span>
        <div className="ml-auto flex items-center gap-0.5">
          <IconButton
            size="sm"
            label={auto ? "Auto-scroll on" : "Auto-scroll off"}
            aria-pressed={auto}
            className={cn(auto && "text-accent")}
            onClick={() => {
              setAuto(!auto);
              setDefaults({ autoScrollLogs: !auto });
            }}
          >
            <ArrowDownToLine className="size-3.5" aria-hidden />
          </IconButton>
          <IconButton size="sm" label={wrap ? "Wrap lines: on" : "Wrap lines: off"} aria-pressed={wrap} className={cn(wrap && "text-accent")} onClick={() => setWrap(!wrap)}>
            <WrapText className="size-3.5" aria-hidden />
          </IconButton>
          <CopyButton text={text} label="Copy log" />
          <IconButton size="sm" label="Download log" onClick={download} disabled={!lines.length}>
            <Download className="size-3.5" aria-hidden />
          </IconButton>
        </div>
      </div>
      <div
        ref={scroller}
        role="log"
        aria-live="off"
        aria-label="Run log"
        tabIndex={0}
        onScroll={(e) => {
          const el2 = e.currentTarget;
          const atBottom = el2.scrollHeight - el2.scrollTop - el2.clientHeight < 24;
          if (!atBottom && auto && active) setAuto(false);
        }}
        className="min-h-[160px] flex-1 overflow-auto bg-bg/70 py-2 font-mono text-xs leading-[18px] focus-visible:outline-offset-[-2px]"
      >
        {loading ? (
          <SkeletonRows rows={6} className="px-3" />
        ) : error ? (
          <InlineError className="mx-3" error={error} />
        ) : lines.length === 0 ? (
          <p className="px-3 text-muted">{active ? "Waiting for output…" : "This run wrote no log."}</p>
        ) : (
          <>
            {visible.length < lines.length ? (
              <button type="button" onClick={() => setShowAll(true)} className="mx-3 mb-2 text-xs text-accent hover:underline">
                Show all {lines.length.toLocaleString()} lines ({(lines.length - visible.length).toLocaleString()} hidden)
              </button>
            ) : null}
            <LogLines lines={visible} wrap={wrap} />
          </>
        )}
      </div>
      <ConfirmDialog
        open={confirmCancel}
        onOpenChange={setConfirmCancel}
        title="Cancel this run?"
        confirmLabel="Cancel run"
        tone="danger"
        onConfirm={() =>
          cancel.mutate(r.id, {
            onError: (e) => toast({ tone: "error", title: "Cancel failed", description: e instanceof Error ? e.message : String(e) }),
          })
        }
      >
        The server kills the running process tree for <span className="font-mono text-fg">{r.id}</span>. Outputs of finished steps stay on disk; the current step is
        marked cancelled.
      </ConfirmDialog>
    </section>
  );
}
