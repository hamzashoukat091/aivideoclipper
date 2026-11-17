import { AlertOctagon, RotateCw, ServerOff, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { describeError } from "@/api/client";
import { cn } from "@/lib/cn";
import { Button } from "./Button";

export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden className={cn("skeleton h-4", className)} />;
}

export function SkeletonRows({ rows = 5, className }: { rows?: number; className?: string }) {
  return (
    <div className={cn("space-y-2", className)} role="status" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} className={cn("h-8", i % 3 === 2 && "w-4/5")} />
      ))}
    </div>
  );
}

export function EmptyState({
  icon: Icon,
  title,
  children,
  action,
  className,
}: {
  icon: LucideIcon;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col items-center justify-center px-6 py-10 text-center", className)}>
      <div className="mb-3 flex size-10 items-center justify-center rounded border border-line bg-panel2">
        <Icon className="size-5 text-muted" aria-hidden />
      </div>
      <h3 className="text-base font-medium text-fg">{title}</h3>
      {children ? <div className="mt-1 max-w-md text-sm text-muted">{children}</div> : null}
      {action ? <div className="mt-4 flex flex-wrap justify-center gap-2">{action}</div> : null}
    </div>
  );
}

/** Shows the server's `message` and the error code (UI_SPEC section 6). */
export function ErrorState({ error, onRetry, className, title }: { error: unknown; onRetry?: () => void; className?: string; title?: string }) {
  const e = describeError(error);
  const unreachable = e.code === "server_unreachable";
  const Icon = unreachable ? ServerOff : AlertOctagon;
  return (
    <div role="alert" className={cn("flex flex-col items-center justify-center px-6 py-10 text-center", className)}>
      <div className="mb-3 flex size-10 items-center justify-center rounded border border-bad/30 bg-bad/10">
        <Icon className="size-5 text-bad" aria-hidden />
      </div>
      <h3 className="text-base font-medium text-fg">{title ?? (unreachable ? "Server not reachable" : "Something went wrong")}</h3>
      <p className="mt-1 max-w-lg text-sm text-muted">{e.message}</p>
      <p className="mt-2 font-mono text-xs text-faint">
        {e.code}
        {e.status ? ` · HTTP ${e.status}` : ""}
      </p>
      {onRetry ? (
        <Button className="mt-4" size="sm" icon={<RotateCw className="size-3.5" aria-hidden />} onClick={onRetry}>
          Retry
        </Button>
      ) : null}
    </div>
  );
}

export function InlineError({ error, className }: { error: unknown; className?: string }) {
  const e = describeError(error);
  return (
    <div role="alert" className={cn("rounded border border-bad/30 bg-bad/[0.07] px-3 py-2 text-sm text-fg", className)}>
      <span className="text-bad">{e.message}</span>
      <span className="ml-2 font-mono text-xs text-faint">{e.code}</span>
    </div>
  );
}
