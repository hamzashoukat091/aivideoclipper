/**
 * DEV-ONLY (VITE_MOCK=1): serves the real files of data/jobs/<id>/ read-only, with HTTP Range, so the
 * players can be checked without the Python server. Thumbnails/posters come from .mock-cache (made by
 * scripts/make-fixtures.mjs if ffmpeg is present). Never used in production builds.
 */
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Plugin } from "vite";

const ROOT = resolve(process.cwd(), "..");
const JOBS = join(ROOT, "data", "jobs");
const CACHE = resolve(process.cwd(), ".mock-cache");
const MIME: Record<string, string> = {
  ".mp4": "video/mp4",
  ".mkv": "video/x-matroska",
  ".webm": "video/webm",
  ".json": "application/json",
  ".ass": "text/plain; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".log": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".wav": "audio/wav",
};

function inside(base: string, p: string): boolean {
  const rel = relative(base, p);
  return rel !== "" && !rel.split(sep).includes("..") && !isAbsolute(rel);
}

function send(req: IncomingMessage, res: ServerResponse, file: string, download: string | null): void {
  const size = statSync(file).size;
  const type = MIME[extname(file).toLowerCase()] ?? "application/octet-stream";
  res.setHeader("Accept-Ranges", "bytes");
  res.setHeader("Content-Type", type);
  if (download) res.setHeader("Content-Disposition", `attachment; filename="${download}"`);
  const m = /bytes=(\d*)-(\d*)/.exec(req.headers.range ?? "");
  if (m) {
    const start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]));
    const end = m[1] && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
    if (start >= size || start > end) {
      res.statusCode = 416;
      res.setHeader("Content-Range", `bytes */${size}`);
      res.end();
      return;
    }
    res.statusCode = 206;
    res.setHeader("Content-Range", `bytes ${start}-${end}/${size}`);
    res.setHeader("Content-Length", String(end - start + 1));
    createReadStream(file, { start, end }).pipe(res);
    return;
  }
  res.setHeader("Content-Length", String(size));
  createReadStream(file).pipe(res);
}

function notFound(res: ServerResponse): void {
  res.statusCode = 404;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({ error: "not_found", message: "File not found (mock media)" }));
}

export function mockMedia(): Plugin {
  return {
    name: "clipper-mock-media",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = new URL(req.url ?? "/", "http://x");
        const path = decodeURIComponent(url.pathname);
        const download = url.searchParams.get("download") === "1";
        let m = /^\/api\/jobs\/([a-z0-9][a-z0-9_-]{0,63})\/thumbnail$/.exec(path);
        if (m) {
          const f = join(CACHE, m[1], "thumb.jpg");
          return existsSync(f) ? send(req, res, f, null) : notFound(res);
        }
        m = /^\/api\/jobs\/([a-z0-9][a-z0-9_-]{0,63})\/clips\/([a-z0-9_-]{1,32})\/poster$/.exec(path);
        if (m) {
          const f = join(CACHE, m[1], "posters", `${m[2]}.jpg`);
          return existsSync(f) ? send(req, res, f, null) : notFound(res);
        }
        m = /^\/api\/jobs\/([a-z0-9][a-z0-9_-]{0,63})\/export\.zip$/.exec(path);
        if (m) {
          res.statusCode = 501;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ error: "mock", message: "Zip export needs the real server." }));
          return;
        }
        m = /^\/media\/([a-z0-9][a-z0-9_-]{0,63})\/(.+)$/.exec(path);
        if (!m) return next();
        const jobDir = join(JOBS, m[1]);
        let file: string;
        if (m[2] === "source") {
          try {
            const meta = JSON.parse(readFileSync(join(jobDir, "meta.json"), "utf-8")) as { media?: string };
            file = meta.media ?? "";
          } catch {
            return notFound(res);
          }
        } else {
          file = resolve(jobDir, m[2]);
          if (!inside(jobDir, file)) {
            res.statusCode = 400;
            res.end(JSON.stringify({ error: "bad_path", message: "Path escapes the job folder" }));
            return;
          }
        }
        if (!file || !existsSync(file) || !statSync(file).isFile()) return notFound(res);
        const name = `${m[1]}-${m[2].split("/").pop() ?? "file"}`;
        return send(req, res, file, download ? name : null);
      });
    },
  };
}
