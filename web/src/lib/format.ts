/** Formatting helpers. Callers render numbers with tabular numerals (`tnum` / font-mono). */

export function fmtClock(sec: number | null | undefined, opts: { ms?: boolean } = {}): string {
  if (sec === null || sec === undefined || !Number.isFinite(sec)) return "--:--";
  const neg = sec < 0;
  let s = Math.abs(sec);
  const h = Math.floor(s / 3600);
  s -= h * 3600;
  const m = Math.floor(s / 60);
  s -= m * 60;
  const whole = Math.floor(s);
  const pad = (n: number) => String(n).padStart(2, "0");
  let out = h > 0 ? `${h}:${pad(m)}:${pad(whole)}` : `${pad(m)}:${pad(whole)}`;
  if (opts.ms) out += `.${String(Math.min(99, Math.floor((s - whole) * 100))).padStart(2, "0")}`;
  return (neg ? "-" : "") + out;
}

export function fmtSeconds(sec: number | null | undefined, digits = 1): string {
  if (sec === null || sec === undefined || !Number.isFinite(sec)) return "—";
  return `${sec.toFixed(digits)} s`;
}

export function fmtDuration(sec: number | null | undefined): string {
  if (sec === null || sec === undefined || !Number.isFinite(sec)) return "—";
  if (sec < 60) return `${Math.round(sec)}s`;
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  if (m < 60) return `${m}m ${String(s).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

export function fmtBytes(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

export function fmtUsd(v: number | null | undefined, digits = 2): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  if (v > 0 && v < 0.01) return "<$0.01";
  return `$${v.toFixed(digits)}`;
}

export function fmtNumber(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  return new Intl.NumberFormat("en-US").format(v);
}

export function fmtCompact(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(v);
}

export function fmtFps(fps: number | null | undefined): string {
  if (!fps || !Number.isFinite(fps)) return "—";
  return `${Math.round(fps * 100) / 100} fps`;
}

/** "30000/1001" -> 29.97 */
export function parseRate(rate: string | number | null | undefined): number | null {
  if (rate === null || rate === undefined) return null;
  if (typeof rate === "number") return Number.isFinite(rate) && rate > 0 ? rate : null;
  const [a, b] = rate.split("/").map(Number);
  const v = b ? a / b : a;
  return Number.isFinite(v) && v > 0 ? v : null;
}

export function parseDate(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function fmtDateTime(iso: string | null | undefined): string {
  const d = parseDate(iso);
  if (!d) return "—";
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function fmtRelative(iso: string | null | undefined, now: number = Date.now()): string {
  const d = parseDate(iso);
  if (!d) return "—";
  const diff = Math.round((now - d.getTime()) / 1000);
  if (diff < 45) return "just now";
  if (diff < 3600) return `${Math.round(diff / 60)} min ago`;
  if (diff < 86400) return `${Math.round(diff / 3600)} h ago`;
  if (diff < 86400 * 7) return `${Math.round(diff / 86400)} d ago`;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

/** "20240430" -> "Apr 30, 2024" */
export function fmtUploadDate(s: string | null | undefined): string | null {
  if (!s || !/^\d{8}$/.test(s)) return null;
  const d = new Date(Number(s.slice(0, 4)), Number(s.slice(4, 6)) - 1, Number(s.slice(6, 8)));
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

export function elapsedSeconds(start: string | null | undefined, end: string | null | undefined, now: number): number | null {
  const s = parseDate(start);
  if (!s) return null;
  const e = parseDate(end);
  return Math.max(0, ((e ? e.getTime() : now) - s.getTime()) / 1000);
}

export function resolutionLabel(height: number | null | undefined): string | null {
  if (!height) return null;
  if (height >= 2160) return "4K";
  if (height >= 1440) return "1440p";
  return `${height}p`;
}

export function pluralize(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

export function str(v: unknown): string | null {
  if (typeof v === "string") return v;
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return null;
}

export function num(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return null;
}
