import { AlertTriangle, Check, CircleDashed, Clock, Loader2, MinusCircle, X, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import type { RunInfo, RunStep, StageState } from "@/api/types";
import { cn } from "@/lib/cn";
import { STATE_STYLE } from "@/lib/stages";

type AnyState = StageState | RunStep["state"] | RunInfo["state"];

const ICON: Record<AnyState, LucideIcon> = {
  done: Check,
  running: Loader2,
  queued: Clock,
  stale: AlertTriangle,
  partial: AlertTriangle,
  failed: X,
  skipped: MinusCircle,
  missing: CircleDashed,
  cancelled: MinusCircle,
};

/** Coloured badge with icon + text (never colour alone). */
export function StateBadge({ state, label, className }: { state: AnyState; label?: string; className?: string }) {
  const s = STATE_STYLE[state];
  const Icon = ICON[state];
  return (
    <span
      className={cn(
        "inline-flex h-5 shrink-0 items-center gap-1 rounded-sm border border-current/0 bg-fg/[0.04] px-1.5 text-xs font-medium",
        s.text,
        className,
      )}
    >
      <Icon className={cn("size-3", state === "running" && "animate-spin")} aria-hidden />
      {label ?? s.label}
    </span>
  );
}

export function StateDot({ state, className, title }: { state: AnyState; className?: string; title?: string }) {
  const s = STATE_STYLE[state];
  return (
    <span
      role="img"
      aria-label={title ?? s.label}
      className={cn("inline-block size-2 shrink-0 rounded-full", s.dot, state === "running" && "animate-pulse-dot", className)}
    />
  );
}

export function StateIcon({ state, className }: { state: AnyState; className?: string }) {
  const s = STATE_STYLE[state];
  const Icon = ICON[state];
  return <Icon className={cn("size-3.5 shrink-0", s.text, state === "running" && "animate-spin", className)} role="img" aria-label={s.label} />;
}

export function Chip({ children, className, mono, title }: { children: ReactNode; className?: string; mono?: boolean; title?: string }) {
  return (
    <span
      title={title}
      className={cn(
        "inline-flex h-5 shrink-0 items-center gap-1 rounded-sm border border-line bg-panel2 px-1.5 text-xs text-muted",
        mono && "font-mono tnum",
        className,
      )}
    >
      {children}
    </span>
  );
}

