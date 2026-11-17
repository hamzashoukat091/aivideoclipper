/**
 * HTTP client for the Clipper server (UI_SPEC section 4). All responses are JSON; errors are
 * `{error, message, ...extra}` and surface as ApiError so every view can show the code and message.
 * With VITE_MOCK=1 (dev only) requests are answered by ./mock instead of the network.
 */

export const MOCK = import.meta.env.VITE_MOCK === "1";

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly extra: Record<string, unknown>;

  constructor(status: number, code: string, message: string, extra: Record<string, unknown> = {}) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

export interface RequestOptions {
  method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  body?: unknown;
  signal?: AbortSignal;
  /** Milliseconds before the request is aborted with ApiError("timeout"). Default 30 s. */
  timeoutMs?: number;
}

const UNREACHABLE =
  "Cannot reach the Clipper server on 127.0.0.1:8765. Start it with `.venv/Scripts/python -m server` and retry.";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isErrorBody(v: unknown): v is { error: string; message?: string } & Record<string, unknown> {
  return isRecord(v) && typeof v.error === "string";
}

export function errorFromBody(status: number, data: unknown, fallbackText: string): ApiError {
  if (isErrorBody(data)) {
    const { error, message, ...extra } = data;
    return new ApiError(status, error, typeof message === "string" ? message : error, extra);
  }
  // FastAPI validation errors: {"detail": [...]}
  if (isRecord(data) && "detail" in data) {
    const detail = data.detail;
    const msg = typeof detail === "string" ? detail : JSON.stringify(detail);
    return new ApiError(status, status === 422 ? "validation_error" : `http_${status}`, msg);
  }
  // The Vite dev proxy answers 500/502/504 with an empty body when the backend is down.
  if ((status === 500 || status === 502 || status === 503 || status === 504) && !fallbackText.trim()) {
    return new ApiError(status, "server_unreachable", UNREACHABLE);
  }
  return new ApiError(status, `http_${status}`, fallbackText.slice(0, 400) || `HTTP ${status}`);
}

export async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  if (MOCK) {
    const { mockRequest } = await import("./mock");
    return mockRequest<T>(path, opts);
  }
  const ctl = new AbortController();
  let timedOut = false;
  const timer = window.setTimeout(() => {
    timedOut = true;
    ctl.abort();
  }, opts.timeoutMs ?? 30000);
  const onAbort = () => ctl.abort();
  opts.signal?.addEventListener("abort", onAbort);
  let res: Response;
  let text: string;
  try {
    res = await fetch(path, {
      method: opts.method ?? "GET",
      headers: opts.body !== undefined ? { "Content-Type": "application/json", Accept: "application/json" } : { Accept: "application/json" },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: ctl.signal,
    });
    text = await res.text();
  } catch (e) {
    if (timedOut) throw new ApiError(0, "timeout", `The server did not answer ${path} in time. Retry; if it persists, check the server console.`);
    if (e instanceof DOMException && e.name === "AbortError") throw e;
    throw new ApiError(0, "server_unreachable", UNREACHABLE);
  } finally {
    window.clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onAbort);
  }
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }
  if (!res.ok) throw errorFromBody(res.status, data, text);
  return data as T;
}

/** Fetch a raw file (file viewer). Works in mock mode too: the dev media middleware serves real files. */
export async function fetchText(url: string, signal?: AbortSignal): Promise<string> {
  let res: Response;
  try {
    res = await fetch(url, { signal });
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") throw e;
    throw new ApiError(0, "server_unreachable", UNREACHABLE);
  }
  const text = await res.text();
  if (!res.ok) {
    let data: unknown = null;
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
    throw errorFromBody(res.status, data, text);
  }
  return text;
}

export function describeError(e: unknown): { code: string; message: string; status: number | null } {
  if (e instanceof ApiError) return { code: e.code, message: e.message, status: e.status || null };
  if (e instanceof Error) return { code: "client_error", message: e.message, status: null };
  return { code: "unknown", message: String(e), status: null };
}

export function withDownload(url: string): string {
  return url.includes("?") ? `${url}&download=1` : `${url}?download=1`;
}
