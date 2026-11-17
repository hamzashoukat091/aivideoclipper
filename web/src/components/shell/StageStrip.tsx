import type { Stage } from "@/api/types";
import { Tooltip } from "@/components/ui/Tooltip";
import { cn } from "@/lib/cn";
import { STATE_STYLE } from "@/lib/stages";

/** The 7-dot stage strip (UI_SPEC 5.1) with a tooltip per stage. */
export function StageStrip({ stages, size = "md", tooltips = true, focusable = true, className }: { stages: Stage[]; size?: "sm" | "md"; tooltips?: boolean; focusable?: boolean; className?: string }) {
  return (
    <div className={cn("flex items-center", size === "sm" ? "gap-1" : "gap-1.5", className)} role="list" aria-label="Pipeline stages">
      {stages.map((s) => {
        const st = STATE_STYLE[s.state];
        const dot = (
          <span
            role="listitem"
            aria-label={`${s.label}: ${st.label}${s.note ? ` — ${s.note}` : ""}`}
            tabIndex={tooltips && focusable ? 0 : undefined}
            className={cn(
              "inline-block shrink-0 rounded-full",
              size === "sm" ? "size-1.5" : "h-2 w-4 rounded-sm",
              st.dot,
              s.state === "running" && "animate-pulse-dot",
            )}
          />
        );
        return tooltips ? (
          <Tooltip
            key={s.key}
            content={
              <span>
                <span className="font-medium">{s.label}</span> · <span className={st.text}>{st.label}</span>
                {s.note ? <span className="block text-muted">{s.note}</span> : null}
              </span>
            }
          >
            {dot}
          </Tooltip>
        ) : (
          <span key={s.key}>{dot}</span>
        );
      })}
    </div>
  );
}
