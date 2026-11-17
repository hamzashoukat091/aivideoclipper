import * as RTabs from "@radix-ui/react-tabs";
import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

export const TabsRoot = RTabs.Root;

export function TabsList({ children, className, label }: { children: ReactNode; className?: string; label: string }) {
  return (
    <RTabs.List aria-label={label} className={cn("flex shrink-0 items-center gap-0.5 overflow-x-auto border-b border-line px-2", className)}>
      {children}
    </RTabs.List>
  );
}

export function TabsTrigger({ value, children, className }: { value: string; children: ReactNode; className?: string }) {
  return (
    <RTabs.Trigger
      value={value}
      className={cn(
        "relative -mb-px inline-flex h-9 shrink-0 items-center gap-1.5 whitespace-nowrap border-b-2 border-transparent px-2.5 text-sm text-muted",
        "transition-colors duration-150 hover:text-fg data-[state=active]:border-accent data-[state=active]:text-fg",
        className,
      )}
    >
      {children}
    </RTabs.Trigger>
  );
}

export function TabsContent({ value, children, className }: { value: string; children: ReactNode; className?: string }) {
  return (
    <RTabs.Content value={value} className={cn("min-h-0 flex-1 focus-visible:outline-none data-[state=active]:animate-fade-in data-[state=inactive]:hidden", className)}>
      {children}
    </RTabs.Content>
  );
}
