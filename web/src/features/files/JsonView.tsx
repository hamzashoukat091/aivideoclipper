import { ChevronDown, ChevronRight } from "lucide-react";
import { memo, useState } from "react";
import { cn } from "@/lib/cn";

const PAGE = 200;

function Primitive({ v }: { v: unknown }) {
  if (v === null) return <span className="text-faint">null</span>;
  if (typeof v === "string") return <span className="break-all text-ok">"{v}"</span>;
  if (typeof v === "number") return <span className="text-run">{String(v)}</span>;
  if (typeof v === "boolean") return <span className="text-warn">{String(v)}</span>;
  return <span className="text-muted">{String(v)}</span>;
}

const Node = memo(function Node({ name, value, depth, isLast }: { name: string | null; value: unknown; depth: number; isLast: boolean }) {
  const isArr = Array.isArray(value);
  const isObj = !isArr && typeof value === "object" && value !== null;
  const entries: [string, unknown][] = isArr ? (value as unknown[]).map((v, i) => [String(i), v]) : isObj ? Object.entries(value as Record<string, unknown>) : [];
  const big = entries.length > 50;
  const [open, setOpen] = useState(depth < 1 || (depth < 2 && !big));
  const [shown, setShown] = useState(PAGE);
  const comma = isLast ? "" : ",";
  const key =
    name !== null ? (
      <>
        <span className="text-fg/80">{isArr || /^\d+$/.test(name) ? name : `"${name}"`}</span>
        <span className="text-faint">: </span>
      </>
    ) : null;

  if (!isArr && !isObj) {
    return (
      <div className="pl-4" style={{ paddingLeft: depth * 14 + 16 }}>
        {key}
        <Primitive v={value} />
        <span className="text-faint">{comma}</span>
      </div>
    );
  }
  const [o, c] = isArr ? ["[", "]"] : ["{", "}"];
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="row-hover flex w-full items-center text-left"
        style={{ paddingLeft: depth * 14 }}
      >
        {open ? <ChevronDown className="size-3.5 shrink-0 text-faint" aria-hidden /> : <ChevronRight className="size-3.5 shrink-0 text-faint" aria-hidden />}
        <span className="pl-0.5">
          {key}
          <span className="text-faint">{o}</span>
          {!open ? (
            <>
              <span className="mx-1 rounded-sm bg-raised px-1 text-muted">
                {entries.length} {isArr ? "items" : "keys"}
              </span>
              <span className="text-faint">
                {c}
                {comma}
              </span>
            </>
          ) : null}
        </span>
      </button>
      {open ? (
        <>
          {entries.slice(0, shown).map(([k, v], i) => (
            <Node key={k} name={isArr ? k : k} value={v} depth={depth + 1} isLast={i === entries.length - 1} />
          ))}
          {entries.length > shown ? (
            <button type="button" onClick={() => setShown(shown + PAGE)} className="text-accent hover:underline" style={{ paddingLeft: (depth + 1) * 14 + 16 }}>
              Show {Math.min(PAGE, entries.length - shown)} more of {entries.length - shown} remaining
            </button>
          ) : null}
          <div className={cn("text-faint")} style={{ paddingLeft: depth * 14 + 16 }}>
            {c}
            {comma}
          </div>
        </>
      ) : null}
    </div>
  );
});

/** Collapsible, syntax-coloured JSON viewer (big arrays paged). */
export function JsonView({ value }: { value: unknown }) {
  return (
    <div className="font-mono text-xs leading-5">
      <Node name={null} value={value} depth={0} isLast />
    </div>
  );
}
