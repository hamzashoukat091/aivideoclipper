/**
 * Live run stream (UI_SPEC: GET /api/runs/{id}/stream, SSE). Events: `log` (one line), `state` (RunInfo json),
 * `end`. The server replays the existing log on every (re)connect, so consumers reset their buffer in onOpen.
 * Reconnects with backoff when the connection drops before `end`.
 */
import { MOCK } from "./client";
import type { RunInfo } from "./types";

export interface StreamHandlers {
  onOpen: () => void;
  onLog: (line: string) => void;
  onState: (run: RunInfo) => void;
  onEnd: () => void;
  onConnection: (state: "connecting" | "open" | "retrying" | "closed") => void;
}

function isRunInfo(v: unknown): v is RunInfo {
  return typeof v === "object" && v !== null && "id" in v && "state" in v && "steps" in v;
}

export function openRunStream(run: Pick<RunInfo, "id" | "stream_url">, h: StreamHandlers): () => void {
  if (MOCK) {
    let cancel: (() => void) | null = null;
    let closed = false;
    void import("./mock").then((m) => {
      if (!closed) cancel = m.mockSubscribe(run.id, h);
    });
    return () => {
      closed = true;
      cancel?.();
    };
  }

  let es: EventSource | null = null;
  let ended = false;
  let attempt = 0;
  let timer: number | undefined;

  const connect = () => {
    h.onConnection(attempt === 0 ? "connecting" : "retrying");
    es = new EventSource(run.stream_url);
    es.onopen = () => {
      attempt = 0;
      h.onConnection("open");
      h.onOpen();
    };
    es.addEventListener("log", (e) => h.onLog((e as MessageEvent<string>).data));
    es.addEventListener("state", (e) => {
      try {
        const parsed: unknown = JSON.parse((e as MessageEvent<string>).data);
        if (isRunInfo(parsed)) h.onState(parsed);
      } catch {
        /* ignore malformed state frames */
      }
    });
    es.addEventListener("end", () => {
      ended = true;
      es?.close();
      h.onConnection("closed");
      h.onEnd();
    });
    es.onerror = () => {
      if (ended) return;
      if (es && es.readyState === EventSource.CLOSED) {
        // The browser gave up (e.g. HTTP error). Retry ourselves with backoff.
        attempt += 1;
        h.onConnection("retrying");
        timer = window.setTimeout(connect, Math.min(15000, 1000 * 2 ** Math.min(attempt, 4)));
      } else {
        h.onConnection("retrying"); // browser auto-reconnects; onopen fires again
      }
    };
  };
  connect();

  return () => {
    ended = true;
    window.clearTimeout(timer);
    es?.close();
  };
}
