import { AlertTriangle, CircleDollarSign, KeyRound } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { ApiError } from "@/api/client";
import { useEstimate, useStartRun, useSystem } from "@/api/hooks";
import type { RunInfo } from "@/api/types";
import { Button } from "@/components/ui/Button";
import { DialogContent, DialogRoot } from "@/components/ui/Dialog";
import { InlineError, Skeleton } from "@/components/ui/Feedback";
import { cn } from "@/lib/cn";
import { fmtNumber, fmtUsd } from "@/lib/format";
import { JUDGE_MODELS, useDefaults, type JudgeModel } from "@/lib/settings";
import { toast } from "@/lib/toast";
import type { PaidRequest } from "./useRunAction";

/**
 * The PAID guard (UI_SPEC section 0/5.3): free estimate first, shows the amount and the judge-model trade-offs,
 * and only an explicit click sends confirm_paid: true. Never auto-confirms; Cancel has initial focus.
 */
export function PaidConfirmDialog({ jobId, request, onClose, onStarted }: { jobId: string; request: PaidRequest | null; onClose: () => void; onStarted?: (r: RunInfo) => void }) {
  const open = request !== null;
  const defaults = useDefaults();
  const uid = useId();
  const [judge, setJudge] = useState<JudgeModel>(defaults.judgeModel);
  const [top, setTop] = useState(defaults.topN);
  const [topText, setTopText] = useState(String(defaults.topN));
  const cancelRef = useRef<HTMLButtonElement>(null);
  const sys = useSystem();
  const start = useStartRun(jobId);

  useEffect(() => {
    if (!request) return;
    const j = request.body.judge_model ?? request.estimate?.judge_model;
    setJudge(j === "haiku" || j === "sonnet" || j === "opus" ? j : defaults.judgeModel);
    const t = request.body.top ?? defaults.topN;
    setTop(t);
    setTopText(String(t));
    start.reset();
    // only when a new request opens
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request]);

  const est = useEstimate(jobId, judge, top, open);
  const keyMissing = sys.data ? !sys.data.keys.anthropic : false;
  const e = est.data;
  const topErr = !/^\d+$/.test(topText) || Number(topText) < 1 || Number(topText) > 50 ? "1–50" : null;
  const estimateReady = !!e && !est.isFetching && !est.isPlaceholderData;
  const canConfirm = estimateReady && !keyMissing && !topErr && !start.isPending;

  const confirm = () => {
    if (!request || !canConfirm) return;
    start.mutate(
      { ...request.body, judge_model: judge, top, confirm_paid: true },
      {
        onSuccess: (r) => {
          toast({ tone: "running", title: "Clip selection started (PAID)", description: `${judge} judge · estimate ${fmtUsd(e?.usd ?? null)}`, href: `/jobs/${jobId}`, hrefLabel: "Watch console" });
          onStarted?.(r);
          onClose();
        },
      },
    );
  };

  return (
    <DialogRoot open={open} onOpenChange={(o) => (!o ? onClose() : undefined)}>
      <DialogContent
        title={
          <span className="inline-flex items-center gap-2">
            <span className="rounded-sm bg-accent px-1.5 py-0.5 text-xs font-semibold text-accent-ink">PAID</span>
            {request?.action === "produce" ? "Run everything, including clip selection" : "Run clip selection"}
          </span>
        }
        description="Clip selection calls the Anthropic API and is billed to your key. Check the free estimate, then confirm."
        className="max-w-xl"
        onOpenAutoFocus={(ev) => {
          ev.preventDefault();
          cancelRef.current?.focus();
        }}
        footer={
          <>
            <Button ref={cancelRef} variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button variant="primary" onClick={confirm} disabled={!canConfirm} loading={start.isPending} icon={<CircleDollarSign className="size-4" aria-hidden />}>
              {estimateReady ? `Spend ~${fmtUsd(e?.usd ?? null)} and run` : "Waiting for estimate…"}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          {keyMissing ? (
            <div role="alert" className="flex items-start gap-2 rounded border border-bad/30 bg-bad/[0.07] px-3 py-2 text-sm">
              <KeyRound className="mt-0.5 size-4 shrink-0 text-bad" aria-hidden />
              <span>
                <span className="font-mono">ANTHROPIC_API_KEY</span> is not set. Add it to <span className="font-mono">.env</span> in the project root and restart the server.
              </span>
            </div>
          ) : null}

          <fieldset>
            <legend className="mb-2 text-sm font-medium text-fg">Judge model</legend>
            <div role="radiogroup" aria-label="Judge model" className="space-y-1.5">
              {JUDGE_MODELS.map((m) => {
                const on = judge === m.id;
                return (
                  <button
                    key={m.id}
                    type="button"
                    role="radio"
                    aria-checked={on}
                    onClick={() => setJudge(m.id)}
                    className={cn(
                      "press flex w-full items-start gap-3 rounded border px-3 py-2 text-left",
                      on ? "border-accent/60 bg-accent/[0.06]" : "border-line hover:border-faint/60 hover:bg-fg/[0.03]",
                    )}
                  >
                    <span className={cn("mt-1 inline-flex size-3.5 shrink-0 items-center justify-center rounded-full border", on ? "border-accent" : "border-faint")} aria-hidden>
                      {on ? <span className="size-1.5 rounded-full bg-accent" /> : null}
                    </span>
                    <span className="min-w-0">
                      <span className="text-sm font-medium text-fg">{m.label}</span>
                      {m.id === "haiku" ? <AlertTriangle className="ml-1.5 inline size-3.5 text-warn" aria-label="not recommended" /> : null}
                      <span className="block text-xs text-muted">{m.tradeoff}</span>
                    </span>
                  </button>
                );
              })}
            </div>
          </fieldset>

          <div className="flex items-center gap-3">
            <label htmlFor={`${uid}-top`} className="text-sm text-fg">
              Keep top
            </label>
            <input
              id={`${uid}-top`}
              type="number"
              min={1}
              max={50}
              value={topText}
              onChange={(ev) => {
                setTopText(ev.target.value);
                const n = Number(ev.target.value);
                if (/^\d+$/.test(ev.target.value) && n >= 1 && n <= 50) setTop(n);
              }}
              aria-invalid={!!topErr}
              className="h-8 w-20 rounded border border-line bg-bg px-2 font-mono text-sm text-fg tnum focus:border-accent/70 focus:outline-none aria-[invalid=true]:border-bad/60"
            />
            <span className="text-sm text-muted">clips {topErr ? <span className="text-bad">(1–50)</span> : null}</span>
          </div>

          <div className="rounded border border-line bg-bg/60 p-3" aria-live="polite">
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-sm text-muted">Free estimate (dry run, no API call)</span>
              {est.isFetching ? <span className="text-xs text-run">estimating…</span> : null}
            </div>
            {est.isError ? (
              <InlineError className="mt-2" error={est.error} />
            ) : !e ? (
              <div className="mt-2 space-y-2">
                <Skeleton className="h-8 w-32" />
                <Skeleton className="h-4 w-64" />
              </div>
            ) : (
              <div className={cn("mt-1 transition-opacity", est.isFetching && "opacity-50")}>
                <div className="font-mono text-xl font-semibold text-fg tnum">~{fmtUsd(e.usd)}</div>
                <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
                  <span>
                    judge <span className="font-mono text-fg">{e.judge_model}</span>
                  </span>
                  <span>
                    <span className="font-mono text-fg tnum">{e.proposal_calls ?? "—"}</span> proposal calls
                  </span>
                  <span>
                    <span className="font-mono text-fg tnum">{fmtNumber(e.input_tokens)}</span> input tokens
                  </span>
                  <span>
                    ~<span className="font-mono text-fg tnum">{e.judge_calls ?? "—"}</span> judge calls
                  </span>
                </div>
                {e.usd === null ? <p className="mt-2 text-xs text-warn">The dry run did not print a dollar amount; check the raw output before confirming.</p> : null}
                <details className="mt-2">
                  <summary className="cursor-pointer text-xs text-muted hover:text-fg">Raw dry-run output</summary>
                  <pre className="mt-1.5 max-h-40 overflow-auto whitespace-pre-wrap rounded bg-panel2 p-2 font-mono text-xs text-muted">{e.raw}</pre>
                </details>
              </div>
            )}
          </div>
          <p className="text-xs text-muted">
            Measured on the 10-minute test video: Opus judge $0.19, Sonnet $0.10. The final cost is written to <span className="font-mono">selection/cost.json</span>.
          </p>
          {start.isError ? <InlineError error={start.error} /> : null}
          {start.error instanceof ApiError && start.error.code === "busy" ? <p className="text-xs text-muted">Wait for the active run to finish or cancel it first.</p> : null}
        </div>
      </DialogContent>
    </DialogRoot>
  );
}
