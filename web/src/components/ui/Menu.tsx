import * as DM from "@radix-ui/react-dropdown-menu";
import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

export const MenuRoot = DM.Root;
export const MenuTrigger = DM.Trigger;

export function MenuContent({ children, align = "end", className }: { children: ReactNode; align?: "start" | "end" | "center"; className?: string }) {
  return (
    <DM.Portal>
      <DM.Content
        align={align}
        sideOffset={6}
        collisionPadding={8}
        className={cn("glass z-[60] min-w-[220px] animate-pop-in rounded border border-line p-1 shadow-xl shadow-black/50", className)}
      >
        {children}
      </DM.Content>
    </DM.Portal>
  );
}

export function MenuItem({
  children,
  onSelect,
  disabled,
  icon,
  hint,
  href,
  download,
}: {
  children: ReactNode;
  onSelect?: () => void;
  disabled?: boolean;
  icon?: ReactNode;
  hint?: ReactNode;
  href?: string;
  download?: boolean;
}) {
  const cls =
    "flex h-8 cursor-pointer select-none items-center gap-2 rounded-sm px-2 text-sm text-fg outline-none data-[disabled]:pointer-events-none data-[highlighted]:bg-fg/[0.07] data-[disabled]:opacity-40";
  const inner = (
    <>
      <span className="flex size-4 items-center justify-center text-muted">{icon}</span>
      <span className="flex-1">{children}</span>
      {hint ? <span className="font-mono text-xs text-faint">{hint}</span> : null}
    </>
  );
  if (href && !disabled) {
    return (
      <DM.Item asChild className={cls}>
        <a href={href} download={download}>
          {inner}
        </a>
      </DM.Item>
    );
  }
  return (
    <DM.Item disabled={disabled} onSelect={onSelect} className={cls}>
      {inner}
    </DM.Item>
  );
}

export function MenuLabel({ children }: { children: ReactNode }) {
  return <DM.Label className="px-2 pb-1 pt-1.5 text-xs font-medium uppercase tracking-wider text-faint">{children}</DM.Label>;
}

export function MenuSeparator() {
  return <DM.Separator className="my-1 h-px bg-line" />;
}
