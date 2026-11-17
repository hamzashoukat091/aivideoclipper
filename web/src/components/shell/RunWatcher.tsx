import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { request } from "@/api/client";
import { invalidateJob, useSystem } from "@/api/hooks";
import type { RunInfo } from "@/api/types";
import { ACTION_LABEL } from "@/lib/stages";
import { toast } from "@/lib/toast";

/** Watches the global queue and toasts when a run finishes, fails or is cancelled (UI_SPEC 5, toasts). */
export function RunWatcher() {
  const sys = useSystem();
  const qc = useQueryClient();
  const known = useRef<Map<string, string>>(new Map());

  useEffect(() => {
    const q = sys.data?.queue;
    if (!q) return;
    const active = new Map<string, string>();
    if (q.running) active.set(q.running.id, q.running.job_id);
    q.queued.forEach((r) => active.set(r.id, r.job_id));
    for (const [id, jobId] of known.current) {
      if (active.has(id)) continue;
      // A run left the queue: look up how it ended.
      void request<RunInfo>(`/api/runs/${encodeURIComponent(id)}`)
        .then((run) => {
          const label = ACTION_LABEL[run.action];
          if (run.state === "done") toast({ tone: "success", title: `${label} finished`, description: run.job_id, href: `/jobs/${run.job_id}`, hrefLabel: "Open job" });
          else if (run.state === "failed")
            toast({ tone: "error", title: `${label} failed`, description: run.error ?? run.job_id, href: `/jobs/${run.job_id}/runs?run=${run.id}`, hrefLabel: "View log" });
          else if (run.state === "cancelled") toast({ tone: "info", title: `${label} cancelled`, description: run.job_id });
        })
        .catch(() => undefined)
        .finally(() => invalidateJob(qc, jobId));
    }
    known.current = active;
  }, [sys.data, qc]);

  return null;
}
