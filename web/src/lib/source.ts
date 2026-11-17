/** Source detection + default job id, mirroring the server rule (UI_SPEC section 4, POST /api/jobs). */
export type SourceKind = "empty" | "youtube" | "url" | "local" | "invalid";

export const JOB_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

const YT_RE = /(?:youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/|live\/|embed\/)|youtu\.be\/)([A-Za-z0-9_-]{6,})/i;

export function detectSource(raw: string): { kind: SourceKind; id: string; detail: string } {
  const s = raw.trim().replace(/^"(.*)"$/, "$1");
  if (!s) return { kind: "empty", id: "", detail: "" };
  const yt = YT_RE.exec(s);
  if (yt) {
    const v = yt[1].toLowerCase();
    return { kind: "youtube", id: v.startsWith("-") ? `yt-${v}` : v, detail: `YouTube video ${yt[1]}` };
  }
  if (/^https?:\/\/\S+$/i.test(s)) {
    let host = "";
    try {
      host = new URL(s).hostname;
    } catch {
      return { kind: "invalid", id: "", detail: "Not a valid URL" };
    }
    const last = s.split(/[?#]/)[0].split("/").filter(Boolean).pop() ?? host;
    return { kind: "url", id: slug(last.replace(/\.[^.]+$/, "")) || slug(host), detail: `Web URL on ${host} (yt-dlp)` };
  }
  if (/^([A-Za-z]:[\\/]|\\\\|\/|~[\\/])/.test(s)) {
    const name = s.split(/[\\/]/).pop() ?? "";
    const ext = /\.([A-Za-z0-9]{2,5})$/.exec(name)?.[1]?.toLowerCase();
    return { kind: "local", id: slug(name.replace(/\.[^.]+$/, "")), detail: ext ? `Local .${ext} file (checked by the server)` : "Local path (checked by the server)" };
  }
  return { kind: "invalid", id: "", detail: "Enter an http(s) URL or an absolute local file path" };
}

export function slug(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "")
    .slice(0, 64);
}
