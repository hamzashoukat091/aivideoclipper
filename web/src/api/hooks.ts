/** TanStack Query hooks for every endpoint in UI_SPEC section 4. */
import { keepPreviousData, useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { ApiError, request } from "./client";
import type {
  Candidate,
  Captions,
  EditContext,
  Edits,
  Estimate,
  FileEntry,
  JobDetail,
  JobSummary,
  ReframePlan,
  RunAction,
  RunInfo,
  Selection,
  SystemInfo,
  Transcript,
} from "./types";

const enc = encodeURIComponent;

export const qk = {
  health: ["health"] as const,
  system: ["system"] as const,
  jobs: ["jobs"] as const,
  job: (id: string) => ["job", id] as const,
  transcript: (id: string) => ["transcript", id] as const,
  selection: (id: string) => ["selection", id] as const,
  reframe: (id: string, cid: string) => ["reframe", id, cid] as const,
  captions: (id: string, cid: string) => ["captions", id, cid] as const,
  estimate: (id: string, judge: string, top: number) => ["estimate", id, judge, top] as const,
  files: (id: string) => ["files", id] as const,
  runs: (job: string | null, limit: number) => ["runs", job ?? "*", limit] as const,
  run: (id: string) => ["run", id] as const,
  runLog: (id: string) => ["run-log", id] as const,
  edits: (id: string, cid: string) => ["edits", id, cid] as const,
};

const notFoundIsFinal = (count: number, err: unknown) => !(err instanceof ApiError && (err.status === 404 || err.status === 400)) && count < 2;

export function useHealth() {
  return useQuery({ queryKey: qk.health, queryFn: () => request<{ ok: boolean; version: string }>("/api/health"), refetchInterval: 15000, retry: false });
}

export function useSystem() {
  return useQuery({
    queryKey: qk.system,
    queryFn: () => request<SystemInfo>("/api/system"),
    refetchInterval: (q) => (q.state.data?.queue.running || q.state.data?.queue.queued.length ? 2000 : 6000),
    retry: 1,
  });
}

export function useJobs() {
  return useQuery({
    queryKey: qk.jobs,
    queryFn: () => request<JobSummary[]>("/api/jobs"),
    refetchInterval: (q) => (q.state.data?.some((j) => j.active_run) ? 3000 : 15000),
  });
}

export function useJob(id: string | undefined) {
  return useQuery({
    queryKey: qk.job(id ?? ""),
    queryFn: () => request<JobDetail>(`/api/jobs/${enc(id ?? "")}`),
    enabled: !!id,
    retry: notFoundIsFinal,
    refetchInterval: (q) => (q.state.data?.active_run ? 3000 : false),
  });
}

export function useTranscript(id: string, enabled = true) {
  return useQuery({ queryKey: qk.transcript(id), queryFn: () => request<Transcript>(`/api/jobs/${enc(id)}/transcript`), enabled, retry: notFoundIsFinal, staleTime: 60000 });
}

export function useSelection(id: string, enabled = true) {
  return useQuery({ queryKey: qk.selection(id), queryFn: () => request<Selection>(`/api/jobs/${enc(id)}/selection`), enabled, retry: notFoundIsFinal });
}

export function useReframe(id: string, cid: string, enabled = true) {
  return useQuery({
    queryKey: qk.reframe(id, cid),
    queryFn: () => request<ReframePlan>(`/api/jobs/${enc(id)}/clips/${enc(cid)}/reframe`),
    enabled,
    retry: notFoundIsFinal,
    staleTime: 60000,
  });
}

export function useCaptions(id: string, cid: string, enabled = true) {
  return useQuery({
    queryKey: qk.captions(id, cid),
    queryFn: () => request<Captions>(`/api/jobs/${enc(id)}/clips/${enc(cid)}/captions`),
    enabled,
    retry: notFoundIsFinal,
    staleTime: 60000,
  });
}

/** Free: runs select_clips.py --dry-run on the server. */
export function useEstimate(id: string, judge: string, top: number, enabled: boolean) {
  return useQuery({
    queryKey: qk.estimate(id, judge, top),
    queryFn: ({ signal }) => request<Estimate>(`/api/jobs/${enc(id)}/estimate?judge_model=${enc(judge)}&top=${top}`, { signal, timeoutMs: 90000 }),
    enabled,
    staleTime: 5 * 60000,
    retry: false,
    placeholderData: keepPreviousData,
  });
}

export function useFiles(id: string, enabled = true) {
  return useQuery({ queryKey: qk.files(id), queryFn: () => request<FileEntry[]>(`/api/jobs/${enc(id)}/files`), enabled, retry: notFoundIsFinal });
}

export function useRuns(job: string | null, limit = 50) {
  return useQuery({
    queryKey: qk.runs(job, limit),
    queryFn: () => request<RunInfo[]>(`/api/runs?${job ? `job=${enc(job)}&` : ""}limit=${limit}`),
    refetchInterval: (q) => (q.state.data?.some((r) => r.state === "running" || r.state === "queued") ? 2500 : 10000),
  });
}

export function useRun(runId: string | null) {
  return useQuery({
    queryKey: qk.run(runId ?? ""),
    queryFn: () => request<RunInfo>(`/api/runs/${enc(runId ?? "")}`),
    enabled: !!runId,
    retry: notFoundIsFinal,
  });
}

export function useRunLog(runId: string | null, enabled: boolean) {
  return useQuery({
    queryKey: qk.runLog(runId ?? ""),
    queryFn: () => request<{ text: string; offset: number; done: boolean }>(`/api/runs/${enc(runId ?? "")}/log?offset=0`),
    enabled: !!runId && enabled,
    retry: notFoundIsFinal,
  });
}

// ---------------------------------------------------------------- mutations

/** Refresh everything a run can change for a job. */
export function invalidateJob(qc: QueryClient, jobId: string): void {
  void qc.invalidateQueries({ queryKey: qk.jobs });
  void qc.invalidateQueries({ queryKey: qk.job(jobId) });
  void qc.invalidateQueries({ queryKey: qk.selection(jobId) });
  void qc.invalidateQueries({ queryKey: qk.transcript(jobId) });
  void qc.invalidateQueries({ queryKey: qk.files(jobId) });
  void qc.invalidateQueries({ queryKey: ["reframe", jobId] });
  void qc.invalidateQueries({ queryKey: ["captions", jobId] });
  void qc.invalidateQueries({ queryKey: ["edits", jobId] });
  void qc.invalidateQueries({ queryKey: ["runs"] });
  void qc.invalidateQueries({ queryKey: qk.system });
}

export interface CreateJobBody {
  source: string;
  id?: string;
  language?: string;
  speakers?: number;
  allow_lower?: boolean;
}

export function useCreateJob() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateJobBody) => request<{ job: JobSummary; run: RunInfo }>("/api/jobs", { method: "POST", body }),
    onSuccess: (res) => invalidateJob(qc, res.job.id),
  });
}

export interface RunBody {
  action: RunAction;
  clips?: string[];
  judge_model?: "haiku" | "sonnet" | "opus";
  top?: number;
  fast?: boolean;
  preview?: boolean;
  force?: boolean;
  confirm_paid?: boolean;
  language?: string;
  speakers?: number;
}

export function useStartRun(jobId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: RunBody) => request<RunInfo>(`/api/jobs/${enc(jobId)}/runs`, { method: "POST", body }),
    onSuccess: (run) => {
      qc.setQueryData(qk.run(run.id), run);
      invalidateJob(qc, jobId);
    },
  });
}

export function useCancelRun() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (runId: string) => request<RunInfo>(`/api/runs/${enc(runId)}/cancel`, { method: "POST" }),
    onSuccess: (run) => {
      qc.setQueryData(qk.run(run.id), run);
      invalidateJob(qc, run.job_id);
    },
  });
}

/** PATCH approved with an optimistic update of the selection cache. */
export function usePatchCandidate(jobId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { cid: string; approved: boolean | null }) =>
      request<Candidate>(`/api/jobs/${enc(jobId)}/candidates/${enc(v.cid)}`, { method: "PATCH", body: { approved: v.approved } }),
    onMutate: async (v) => {
      await qc.cancelQueries({ queryKey: qk.selection(jobId) });
      const prev = qc.getQueryData<Selection>(qk.selection(jobId));
      if (prev) {
        qc.setQueryData<Selection>(qk.selection(jobId), {
          ...prev,
          candidates: prev.candidates.map((c) => (c.id === v.cid ? { ...c, approved: v.approved } : c)),
        });
      }
      return { prev };
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(qk.selection(jobId), ctx.prev);
    },
    onSuccess: (cand) => {
      qc.setQueryData<Selection>(qk.selection(jobId), (old) =>
        old ? { ...old, candidates: old.candidates.map((c) => (c.id === cand.id ? cand : c)) } : old,
      );
      void qc.invalidateQueries({ queryKey: qk.job(jobId) });
      void qc.invalidateQueries({ queryKey: qk.jobs });
    },
  });
}

// ---------------------------------------------------------------- clip edits (UI_SPEC 5b)

export function useEdits(id: string, cid: string, enabled: boolean) {
  return useQuery({
    queryKey: qk.edits(id, cid),
    queryFn: () => request<EditContext>(`/api/jobs/${enc(id)}/clips/${enc(cid)}/edits`),
    enabled,
    retry: notFoundIsFinal,
    staleTime: Infinity,
  });
}

function afterEditSave(qc: QueryClient, id: string, cid: string, ctx: EditContext) {
  qc.setQueryData(qk.edits(id, cid), ctx);
  void qc.invalidateQueries({ queryKey: qk.selection(id) });
  void qc.invalidateQueries({ queryKey: qk.reframe(id, cid) });
  void qc.invalidateQueries({ queryKey: qk.job(id) });
  void qc.invalidateQueries({ queryKey: qk.jobs });
  void qc.invalidateQueries({ queryKey: qk.files(id) });
}

export function useSaveEdits(id: string, cid: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (edits: Edits) => request<EditContext>(`/api/jobs/${enc(id)}/clips/${enc(cid)}/edits`, { method: "PUT", body: edits }),
    onSuccess: (ctx) => afterEditSave(qc, id, cid, ctx),
  });
}

export function useResetEdits(id: string, cid: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => request<EditContext>(`/api/jobs/${enc(id)}/clips/${enc(cid)}/edits`, { method: "DELETE" }),
    onSuccess: (ctx) => afterEditSave(qc, id, cid, ctx),
  });
}
