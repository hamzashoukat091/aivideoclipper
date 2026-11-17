import { useQuery } from "@tanstack/react-query";
import { Download, ExternalLink, FileQuestion } from "lucide-react";
import { useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import { fetchText, withDownload } from "@/api/client";
import type { FileEntry } from "@/api/types";
import { VideoBox } from "@/components/media/VideoBox";
import { Button } from "@/components/ui/Button";
import { EmptyState, ErrorState, InlineError, SkeletonRows } from "@/components/ui/Feedback";
import { CopyButton } from "@/components/ui/Misc";
import { Segmented } from "@/components/ui/Segmented";
import { Chip } from "@/components/ui/Status";
import { cn } from "@/lib/cn";
import { fmtBytes, fmtDateTime } from "@/lib/format";
import { JsonView } from "./JsonView";

const AUTO_LOAD_LIMIT = 4 * 1024 * 1024;

function assLineClass(l: string): string {
  if (/^\[.*\]$/.test(l)) return "text-accent";
  if (l.startsWith("Dialogue:")) return "text-fg/90";
  if (l.startsWith("Style:") || l.startsWith("Format:")) return "text-run";
  if (l.startsWith(";")) return "text-faint";
  return "text-muted";
}

function TextBody({ f }: { f: FileEntry }) {
  const [force, setForce] = useState(false);
  const isMd = f.path.toLowerCase().endsWith(".md");
  const isJson = f.kind === "json";
  const [mdMode, setMdMode] = useState<"rendered" | "raw">("rendered");
  const [jsonMode, setJsonMode] = useState<"tree" | "raw">("tree");
  const tooBig = f.size > AUTO_LOAD_LIMIT && !force;
  const q = useQuery({ queryKey: ["file-text", f.url, f.mtime], queryFn: ({ signal }) => fetchText(f.url, signal), enabled: !tooBig, staleTime: 60000, retry: false });
  const parsed = useMemo(() => {
    if (!isJson || !q.data) return { ok: false as const, error: null };
    try {
      return { ok: true as const, value: JSON.parse(q.data) as unknown };
    } catch (e) {
      return { ok: false as const, error: e instanceof Error ? e.message : String(e) };
    }
  }, [isJson, q.data]);

  if (tooBig) {
    return (
      <EmptyState icon={FileQuestion} title={`Large file (${fmtBytes(f.size)})`} action={<Button onClick={() => setForce(true)}>Load anyway</Button>}>
        Not loaded automatically to keep the browser responsive. Download it or load it here.
      </EmptyState>
    );
  }
  if (q.isLoading) return <SkeletonRows rows={10} className="p-4" />;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  const text = q.data ?? "";
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-line px-3">
        {isMd ? (
          <Segmented size="sm" label="Markdown view" value={mdMode} onChange={setMdMode} options={[{ value: "rendered", label: "Rendered" }, { value: "raw", label: "Raw" }]} />
        ) : null}
        {isJson && parsed.ok ? (
          <Segmented size="sm" label="JSON view" value={jsonMode} onChange={setJsonMode} options={[{ value: "tree", label: "Tree" }, { value: "raw", label: "Raw" }]} />
        ) : null}
        <span className="text-xs text-muted tnum">{text.split("\n").length.toLocaleString()} lines</span>
        <div className="ml-auto">
          <CopyButton text={text} label="Copy contents" />
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-4">
        {isJson && !parsed.ok && parsed.error ? <InlineError className="mb-3" error={new Error(`Invalid JSON: ${parsed.error}`)} /> : null}
        {isMd && mdMode === "rendered" ? (
          <article className="md max-w-3xl">
            <ReactMarkdown>{text}</ReactMarkdown>
          </article>
        ) : isJson && parsed.ok && jsonMode === "tree" ? (
          <JsonView value={parsed.value} />
        ) : f.kind === "subtitle" ? (
          <pre className="font-mono text-xs leading-5">
            {text.split(/\r?\n/).map((l, i) => (
              <div key={i} className={cn("whitespace-pre-wrap break-all", assLineClass(l))}>
                {l || " "}
              </div>
            ))}
          </pre>
        ) : (
          <pre className="whitespace-pre-wrap break-all font-mono text-xs leading-5 text-fg/90">{text}</pre>
        )}
      </div>
    </div>
  );
}

export function FileViewer({ f }: { f: FileEntry | null }) {
  if (!f) {
    return (
      <EmptyState icon={FileQuestion} title="Select a file" className="h-full">
        Every intermediate the pipeline writes is here: transcript, clip candidates, crop plans, captions, reports, logs.
      </EmptyState>
    );
  }
  const textual = f.kind === "json" || f.kind === "text" || f.kind === "subtitle";
  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line px-4 py-2.5">
        <h2 className="min-w-0 truncate font-mono text-sm text-fg" title={f.path}>
          {f.path}
        </h2>
        <Chip>{f.kind}</Chip>
        <span className="text-xs text-muted tnum">
          {fmtBytes(f.size)} · {fmtDateTime(f.mtime)}
        </span>
        <div className="ml-auto flex items-center gap-1">
          <CopyButton text={f.path} label="Copy path" />
          <a href={f.url} target="_blank" rel="noreferrer noopener" className="press inline-flex size-7 items-center justify-center rounded text-muted hover:bg-fg/[0.06] hover:text-fg" aria-label="Open raw file in a new tab" title="Open raw">
            <ExternalLink className="size-3.5" aria-hidden />
          </a>
          <a href={withDownload(f.url)} download className="press inline-flex h-7 items-center gap-1.5 rounded bg-accent px-2.5 text-sm font-medium text-accent-ink hover:bg-accent/90">
            <Download className="size-3.5" aria-hidden /> Download
          </a>
        </div>
      </header>
      <div className="min-h-0 flex-1">
        {textual ? (
          <TextBody key={f.url + f.mtime} f={f} />
        ) : f.kind === "video" ? (
          <div className="flex h-full items-center justify-center p-4">
            <VideoBox key={f.url} src={f.url} label={f.path} controls boxClassName="h-full max-h-[70vh] w-full rounded border border-line" />
          </div>
        ) : f.kind === "audio" ? (
          <div className="p-6">
            <audio key={f.url} src={f.url} controls preload="metadata" className="w-full" aria-label={f.path} />
            <p className="mt-2 text-xs text-muted">Analysis audio. Large WAV files stream with HTTP Range.</p>
          </div>
        ) : f.kind === "image" ? (
          <div className="flex h-full items-center justify-center p-4">
            <img src={f.url} alt={f.path} className="max-h-full max-w-full rounded border border-line object-contain" />
          </div>
        ) : (
          <EmptyState icon={FileQuestion} title="No preview for this file type">
            Download it to inspect it locally.
          </EmptyState>
        )}
      </div>
    </div>
  );
}
