import { Loader2 } from "lucide-react";
import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { cn } from "@/lib/cn";
import { Tooltip } from "./Tooltip";

type Variant = "primary" | "secondary" | "ghost" | "danger" | "outline";
type Size = "sm" | "md";

const variants: Record<Variant, string> = {
  primary: "bg-accent text-accent-ink hover:bg-accent/90 font-medium",
  secondary: "bg-raised text-fg hover:bg-line border border-line",
  outline: "border border-line text-fg hover:bg-fg/[0.05] hover:border-faint/60",
  ghost: "text-muted hover:text-fg hover:bg-fg/[0.06]",
  danger: "border border-bad/40 text-bad hover:bg-bad/10",
};
const sizes: Record<Size, string> = {
  sm: "h-7 px-2.5 text-sm gap-1.5",
  md: "h-8 px-3 text-sm gap-2",
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  icon?: ReactNode;
  loading?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "secondary", size = "md", icon, loading, className, children, disabled, type = "button", ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cn(
        "press inline-flex shrink-0 select-none items-center justify-center whitespace-nowrap rounded",
        "disabled:pointer-events-none disabled:opacity-45",
        variants[variant],
        sizes[size],
        className,
      )}
      {...rest}
    >
      {loading ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : icon}
      {children}
    </button>
  );
});

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string;
  shortcut?: string;
  variant?: Variant;
  size?: "sm" | "md";
  tooltipSide?: "top" | "bottom" | "left" | "right";
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, shortcut, variant = "ghost", size = "md", className, children, tooltipSide, type = "button", ...rest },
  ref,
) {
  return (
    <Tooltip content={label} shortcut={shortcut} side={tooltipSide}>
      <button
        ref={ref}
        type={type}
        aria-label={label}
        className={cn(
          "press inline-flex shrink-0 items-center justify-center rounded disabled:pointer-events-none disabled:opacity-40",
          "relative after:absolute after:-inset-1.5 after:content-['']",
          variants[variant],
          size === "sm" ? "size-7" : "size-8",
          className,
        )}
        {...rest}
      >
        {children}
      </button>
    </Tooltip>
  );
});
