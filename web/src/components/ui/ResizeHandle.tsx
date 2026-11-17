import { PanelResizeHandle } from "react-resizable-panels";
import { cn } from "@/lib/cn";

export function ResizeHandle({ vertical }: { vertical?: boolean }) {
  return (
    <PanelResizeHandle
      className={cn(
        "group relative flex items-center justify-center bg-transparent outline-none",
        vertical ? "h-2" : "w-2",
        "data-[resize-handle-state=drag]:bg-accent/20 data-[resize-handle-state=hover]:bg-fg/[0.04] focus-visible:bg-accent/20",
      )}
    >
      <span className={cn("rounded-full bg-line group-data-[resize-handle-state=drag]:bg-accent", vertical ? "h-px w-10" : "h-10 w-px")} />
    </PanelResizeHandle>
  );
}

