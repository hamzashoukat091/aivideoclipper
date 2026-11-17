import * as TG from "@radix-ui/react-toggle-group";
import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

export interface SegmentedOption<T extends string> {
  value: T;
  label: ReactNode;
  ariaLabel?: string;
  activeClass?: string;
  title?: string;
  disabled?: boolean;
}

/** Single-select segmented control (always one value selected). */
export function Segmented<T extends string>({
  value,
  onChange,
  options,
  label,
  size = "md",
  className,
  disabled,
}: {
  value: T;
  onChange: (v: T) => void;
  options: SegmentedOption<T>[];
  label: string;
  size?: "sm" | "md";
  className?: string;
  disabled?: boolean;
}) {
  return (
    <TG.Root
      type="single"
      value={value}
      aria-label={label}
      disabled={disabled}
      onValueChange={(v) => {
        if (v) onChange(v as T);
      }}
      className={cn("inline-flex shrink-0 items-center rounded border border-line bg-panel2 p-0.5", disabled && "opacity-50", className)}
    >
      {options.map((o) => (
        <TG.Item
          key={o.value}
          value={o.value}
          disabled={o.disabled}
          aria-label={o.ariaLabel}
          title={o.title}
          className={cn(
            "press inline-flex items-center justify-center gap-1 whitespace-nowrap rounded-sm px-2 text-sm text-muted hover:text-fg disabled:pointer-events-none disabled:opacity-40",
            size === "sm" ? "h-6 text-xs" : "h-7",
            "data-[state=on]:bg-raised data-[state=on]:text-fg data-[state=on]:shadow-[inset_0_0_0_1px_rgb(var(--line))]",
            o.activeClass, // full class names, e.g. "data-[state=on]:text-ok" (static for Tailwind)
          )}
        >
          {o.label}
        </TG.Item>
      ))}
    </TG.Root>
  );
}
