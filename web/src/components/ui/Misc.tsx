import { Check, Copy } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { cn } from "@/lib/cn";
import { copyText } from "@/lib/clipboard";
import { toast } from "@/lib/toast";
import { IconButton } from "./Button";

export function CopyButton({ text, label = "Copy", size = "sm", className }: { text: string; label?: string; size?: "sm" | "md"; className?: string }) {
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (!done) return;
    const t = window.setTimeout(() => setDone(false), 1400);
    return () => window.clearTimeout(t);
  }, [done]);
  return (
    <IconButton
      label={done ? "Copied" : label}
      size={size}
      className={className}
      onClick={() => {
        void copyText(text).then((ok) => {
          if (ok) setDone(true);
          else toast({ tone: "error", title: "Copy failed", description: "The browser blocked clipboard access." });
        });
      }}
    >
      {done ? <Check className="size-3.5 text-ok" aria-hidden /> : <Copy className="size-3.5" aria-hidden />}
    </IconButton>
  );
}

export function Section({ title, actions, children, className, bodyClass, id }: { title: ReactNode; actions?: ReactNode; children: ReactNode; className?: string; bodyClass?: string; id?: string }) {
  return (
    <section aria-labelledby={id} className={cn("rounded border border-line bg-panel", className)}>
      <header className="flex min-h-10 items-center justify-between gap-3 border-b border-line px-4 py-2">
        <h2 id={id} className="text-sm font-medium text-fg">
          {title}
        </h2>
        {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
      </header>
      <div className={cn("p-4", bodyClass)}>{children}</div>
    </section>
  );
}

export function Switch({ checked, onChange, label, description, id }: { checked: boolean; onChange: (v: boolean) => void; label: string; description?: ReactNode; id: string }) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0">
        <label htmlFor={id} className="text-sm text-fg">
          {label}
        </label>
        {description ? <p className="mt-0.5 text-xs text-muted">{description}</p> : null}
      </div>
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={cn(
          "press relative mt-0.5 inline-flex h-5 w-9 shrink-0 items-center rounded-full border transition-colors",
          checked ? "border-accent bg-accent" : "border-line bg-raised",
        )}
      >
        <span
          aria-hidden
          className={cn("inline-block size-3.5 rounded-full transition-transform duration-150 ease-out", checked ? "translate-x-[18px] bg-accent-ink" : "translate-x-[2px] bg-muted")}
        />
      </button>
    </div>
  );
}

export function KeyValue({ items, className }: { items: [ReactNode, ReactNode][]; className?: string }) {
  return (
    <dl className={cn("grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm", className)}>
      {items.map(([k, v], i) => (
        <div key={i} className="contents">
          <dt className="text-muted">{k}</dt>
          <dd className="min-w-0 break-words text-right font-mono text-fg tnum">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

export function ScoreBar({ label, value, max = 10, compact }: { label: string; value: number | null | undefined; max?: number; compact?: boolean }) {
  const v = typeof value === "number" && Number.isFinite(value) ? value : null;
  const pct = v === null ? 0 : Math.max(0, Math.min(1, v / max)) * 100;
  const tone = v === null ? "bg-idle" : v >= 8 ? "bg-ok" : v >= 6 ? "bg-accent" : v >= 4 ? "bg-warn" : "bg-bad";
  return (
    <div className={cn("flex items-center gap-2", compact ? "text-xs" : "text-sm")} title={`${label}: ${v ?? "—"}/${max}`}>
      <span className={cn("shrink-0 text-muted", compact ? "w-6" : "w-24")}>{label}</span>
      <div className="relative h-1.5 min-w-[28px] flex-1 overflow-hidden rounded-full bg-raised" role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={max} aria-valuenow={v ?? 0}>
        <div className={cn("absolute inset-y-0 left-0 rounded-full", tone)} style={{ width: `${pct}%` }} />
      </div>
      <span className="w-5 shrink-0 text-right font-mono text-fg tnum">{v ?? "—"}</span>
    </div>
  );
}
