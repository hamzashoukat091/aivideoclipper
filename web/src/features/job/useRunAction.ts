import { useState } from "react";
import { ApiError } from "@/api/client";
import { useStartRun, type RunBody } from "@/api/hooks";
import type { Estimate, RunInfo } from "@/api/types";
import { ACTION_LABEL } from "@/lib/stages";
import { toast } from "@/lib/toast";

export interface PaidRequest {
  action: "select" | "produce";
  body: RunBody;
  estimate?: Estimate;
}

function isEstimate(v: unknown): v is Estimate {
  return typeof v === "object" && v !== null && "judge_model" in v && "raw" in v;
}

/**
 * Starts runs for a job. Never sends confirm_paid by itself: a paid action (or a server 402) opens the PAID
 * confirmation dialog through `paid`, and only that dialog's explicit confirm sends confirm_paid: true.
 */
export function useRunAction(jobId: string) {
  const start = useStartRun(jobId);
  const [paid, setPaid] = useState<PaidRequest | null>(null);

  const run = (body: RunBody, opts: { onStarted?: (r: RunInfo) => void } = {}) => {
    if (body.action === "select" && !body.confirm_paid) {
      setPaid({ action: "select", body });
      return;
    }
    start.mutate(body, {
      onSuccess: (r) => {
        toast({ tone: "running", title: `${ACTION_LABEL[r.action]} started`, description: `${r.job_id} · ${r.id}`, href: `/jobs/${r.job_id}`, hrefLabel: "Watch console" });
        opts.onStarted?.(r);
      },
      onError: (e) => {
        if (e instanceof ApiError && e.code === "paid_confirmation_required") {
          setPaid({ action: body.action === "produce" ? "produce" : "select", body, estimate: isEstimate(e.extra.estimate) ? e.extra.estimate : undefined });
          return;
        }
        const msg = e instanceof ApiError ? `${e.message} (${e.code})` : String(e);
        toast({ tone: "error", title: `Could not start ${ACTION_LABEL[body.action]}`, description: msg });
      },
    });
  };

  return { run, pending: start.isPending, pendingAction: start.isPending ? (start.variables?.action ?? null) : null, paid, setPaid };
}
