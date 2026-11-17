import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { invalidateJob, qk, useRunLog } from "./hooks";
import { openRunStream } from "./stream";
import type { RunInfo } from "./types";

const MAX_LINES = 50000;
export type Connection = "connecting" | "open" | "retrying" | "closed" | "static";

/**
 * Lines + live RunInfo for a run. Active runs use SSE (batched to one state update per 100 ms); finished runs
 * load the log once via GET /api/runs/{id}/log.
 */
export function useRunStream(run: RunInfo | null): { lines: string[]; run: RunInfo | null; connection: Connection; loading: boolean; error: unknown } {
  const qc = useQueryClient();
  const active = !!run && (run.state === "running" || run.state === "queued");
  const runId = run?.id ?? null;
  const [lines, setLines] = useState<string[]>([]);
  const [live, setLive] = useState<RunInfo | null>(null);
  const [connection, setConnection] = useState<Connection>("static");
  const buffer = useRef<string[]>([]);
  const reset = useRef(false);
  const streamUrl = run?.stream_url ?? "";
  const jobId = run?.job_id ?? "";

  // When the stream ends, the static log becomes the source of truth.
  const [streamEnded, setStreamEnded] = useState(false);
  const logQuery = useRunLog(runId, !!runId && (!active || streamEnded));

  useEffect(() => {
    setLines([]);
    setLive(null);
    setStreamEnded(false);
    buffer.current = [];
    if (!runId || !active) {
      setConnection("static");
      return;
    }
    const flush = window.setInterval(() => {
      if (!reset.current && buffer.current.length === 0) return;
      const chunk = buffer.current;
      const wasReset = reset.current;
      buffer.current = [];
      reset.current = false;
      setLines((prev) => {
        const next = wasReset ? chunk : prev.concat(chunk);
        return next.length > MAX_LINES ? next.slice(next.length - MAX_LINES) : next;
      });
    }, 100);
    const close = openRunStream({ id: runId, stream_url: streamUrl }, {
      onOpen: () => {
        buffer.current = [];
        reset.current = true;
      },
      onLog: (line) => buffer.current.push(line),
      onState: (info) => {
        setLive(info);
        qc.setQueryData(qk.run(info.id), info);
      },
      onEnd: () => {
        setStreamEnded(true);
        void qc.invalidateQueries({ queryKey: qk.runLog(runId) });
        void qc.invalidateQueries({ queryKey: qk.run(runId) });
        if (jobId) invalidateJob(qc, jobId);
      },
      onConnection: setConnection,
    });
    return () => {
      window.clearInterval(flush);
      close();
    };
    // `active` intentionally only starts the stream; once started it runs until `end`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId, streamUrl]);

  const staticLines = logQuery.data ? splitLog(logQuery.data.text) : null;
  const useStatic = (!active || streamEnded) && staticLines !== null;
  return {
    lines: useStatic ? staticLines : lines,
    run: live ?? run,
    connection: active && !streamEnded ? connection : "static",
    loading: (!active || streamEnded) && logQuery.isLoading,
    error: logQuery.error,
  };
}

function splitLog(text: string): string[] {
  const parts = text.replace(/\r\n/g, "\n").split("\n");
  if (parts.length && parts[parts.length - 1] === "") parts.pop();
  return parts.map((l) => (l.includes("\r") ? (l.split("\r").filter(Boolean).pop() ?? "") : l));
}
