import { ChevronDown, ChevronRight, File, FileAudio, FileJson, FileText, FileVideo, Folder, FolderOpen, Image, Search, Subtitles, type LucideIcon } from "lucide-react";
import { useMemo, useState } from "react";
import { Panel, PanelGroup } from "react-resizable-panels";
import { useSearchParams } from "react-router-dom";
import { useFiles } from "@/api/hooks";
import type { FileEntry } from "@/api/types";
import { EmptyState, ErrorState, SkeletonRows } from "@/components/ui/Feedback";
import { ResizeHandle } from "@/components/ui/ResizeHandle";
import { useJobContext } from "@/features/job/context";
import { cn } from "@/lib/cn";
import { fmtBytes, fmtDateTime } from "@/lib/format";
import { useMediaQuery } from "@/lib/useMediaQuery";
import { FileViewer } from "./FileViewer";

const KIND_ICON: Record<FileEntry["kind"], LucideIcon> = {
  video: FileVideo,
  audio: FileAudio,
  json: FileJson,
  text: FileText,
  image: Image,
  subtitle: Subtitles,
  other: File,
};

interface Dir {
  name: string;
  path: string;
  dirs: Map<string, Dir>;
  files: FileEntry[];
  size: number;
}

function buildTree(files: FileEntry[]): Dir {
  const root: Dir = { name: "", path: "", dirs: new Map(), files: [], size: 0 };
  for (const f of files) {
    const parts = f.path.split("/");
    let d = root;
    d.size += f.size;
    for (let i = 0; i < parts.length - 1; i += 1) {
      const p = parts.slice(0, i + 1).join("/");
      let next = d.dirs.get(parts[i]);
      if (!next) {
        next = { name: parts[i], path: p, dirs: new Map(), files: [], size: 0 };
        d.dirs.set(parts[i], next);
      }
      next.size += f.size;
      d = next;
    }
    d.files.push(f);
  }
  return root;
}

function TreeDir({ dir, depth, selected, onSelect, closed, toggle }: { dir: Dir; depth: number; selected: string | null; onSelect: (p: string) => void; closed: Set<string>; toggle: (p: string) => void }) {
  const dirs = [...dir.dirs.values()].sort((a, b) => a.name.localeCompare(b.name));
  return (
    <>
      {dirs.map((d) => {
        const open = !closed.has(d.path);
        return (
          <li key={d.path}>
            <button type="button" onClick={() => toggle(d.path)} aria-expanded={open} className="row-hover flex h-7 w-full items-center gap-1.5 pr-3 text-left text-sm" style={{ paddingLeft: depth * 14 + 8 }}>
              {open ? <ChevronDown className="size-3.5 shrink-0 text-faint" aria-hidden /> : <ChevronRight className="size-3.5 shrink-0 text-faint" aria-hidden />}
              {open ? <FolderOpen className="size-4 shrink-0 text-accent/80" aria-hidden /> : <Folder className="size-4 shrink-0 text-accent/80" aria-hidden />}
              <span className="truncate text-fg">{d.name}</span>
              <span className="ml-auto shrink-0 font-mono text-xs text-faint tnum">{fmtBytes(d.size)}</span>
            </button>
            {open ? (
              <ul>
                <TreeDir dir={d} depth={depth + 1} selected={selected} onSelect={onSelect} closed={closed} toggle={toggle} />
              </ul>
            ) : null}
          </li>
        );
      })}
      {dir.files.map((f) => {
        const Icon = KIND_ICON[f.kind];
        const name = f.path.split("/").pop() ?? f.path;
        const on = selected === f.path;
        return (
          <li key={f.path}>
            <button
              type="button"
              onClick={() => onSelect(f.path)}
              aria-current={on ? "true" : undefined}
              title={`${f.path} · ${fmtBytes(f.size)} · ${fmtDateTime(f.mtime)}`}
              className={cn("row-hover flex h-7 w-full items-center gap-1.5 pr-3 text-left text-sm", on && "bg-accent/[0.09] shadow-[inset_2px_0_0_rgb(var(--accent))]")}
              style={{ paddingLeft: depth * 14 + 8 + 18 }}
            >
              <Icon className="size-4 shrink-0 text-muted" aria-hidden />
              <span className={cn("truncate", on ? "text-fg" : "text-fg/85")}>{name}</span>
              <span className="ml-auto shrink-0 font-mono text-xs text-faint tnum">{fmtBytes(f.size)}</span>
            </button>
          </li>
        );
      })}
    </>
  );
}

export default function FilesPage() {
  const { job } = useJobContext();
  const files = useFiles(job.id);
  const wide = useMediaQuery("(min-width: 1100px)");
  const [params, setParams] = useSearchParams();
  const selected = params.get("path");
  const [q, setQ] = useState("");
  const [closed, setClosed] = useState<Set<string>>(new Set());
  const list = useMemo(() => {
    const n = q.trim().toLowerCase();
    return (files.data ?? []).filter((f) => !n || f.path.toLowerCase().includes(n));
  }, [files.data, q]);
  const tree = useMemo(() => buildTree(list), [list]);
  const sel = files.data?.find((f) => f.path === selected) ?? null;
  const total = (files.data ?? []).reduce((a, f) => a + f.size, 0);

  const onSelect = (p: string) => setParams({ path: p }, { replace: true });
  const toggle = (p: string) =>
    setClosed((s) => {
      const n = new Set(s);
      if (n.has(p)) n.delete(p);
      else n.add(p);
      return n;
    });

  if (files.isLoading) return <SkeletonRows rows={10} className="p-6" />;
  if (files.isError) return <ErrorState error={files.error} onRetry={() => void files.refetch()} className="py-20" />;
  if (!files.data?.length) {
    return (
      <EmptyState icon={Folder} title="No files yet" className="py-20">
        The job folder is empty. Files appear here as stages run.
      </EmptyState>
    );
  }

  const treePane = (
    <div className="flex h-full min-h-0 flex-col overflow-hidden rounded border border-line bg-panel">
      <div className="shrink-0 border-b border-line p-2">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-faint" aria-hidden />
          <label htmlFor="files-filter" className="sr-only">
            Filter files
          </label>
          <input
            id="files-filter"
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Filter files"
            className="h-8 w-full rounded border border-line bg-bg pl-8 pr-2 text-sm text-fg placeholder:text-faint focus:border-accent/70 focus:outline-none"
          />
        </div>
        <p className="mt-1.5 px-1 text-xs text-muted tnum">
          {files.data.length} files · {fmtBytes(total)} · data/jobs/{job.id}
        </p>
      </div>
      <nav aria-label="Job files" className="min-h-0 flex-1 overflow-y-auto py-1">
        {list.length ? (
          <ul>
            <TreeDir dir={tree} depth={0} selected={selected} onSelect={onSelect} closed={closed} toggle={toggle} />
          </ul>
        ) : (
          <p className="p-3 text-sm text-muted">No file matches “{q}”.</p>
        )}
      </nav>
    </div>
  );
  const viewer = <div className="h-full min-h-0 overflow-hidden rounded border border-line bg-panel">{selected && !sel ? <EmptyState icon={File} title="File not found">{selected} is not in this job.</EmptyState> : <FileViewer f={sel} />}</div>;

  if (!wide) {
    return (
      <div className="space-y-4 p-4">
        <div className="h-[340px]">{treePane}</div>
        <div className="h-[620px]">{viewer}</div>
      </div>
    );
  }
  return (
    <PanelGroup direction="horizontal" autoSaveId="files-split" className="h-full p-4 sm:p-6">
      <Panel defaultSize={30} minSize={20}>
        {treePane}
      </Panel>
      <ResizeHandle />
      <Panel defaultSize={70} minSize={40}>
        {viewer}
      </Panel>
    </PanelGroup>
  );
}
