import * as RD from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

export const DialogRoot = RD.Root;
export const DialogTrigger = RD.Trigger;
export const DialogClose = RD.Close;

export function DialogContent({
  title,
  description,
  children,
  className,
  footer,
  hideClose,
  onOpenAutoFocus,
}: {
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  className?: string;
  footer?: ReactNode;
  hideClose?: boolean;
  onOpenAutoFocus?: (e: Event) => void;
}) {
  const hasBody = children !== undefined && children !== null && children !== false;
  return (
    <RD.Portal>
      <RD.Overlay className="fixed inset-0 z-50 bg-black/55 animate-fade-in" />
      <RD.Content
        onOpenAutoFocus={onOpenAutoFocus}
        {...(description ? {} : { "aria-describedby": undefined })}
        className={cn(
          "glass fixed left-1/2 top-[12vh] z-50 flex max-h-[80vh] w-[calc(100vw-32px)] max-w-lg -translate-x-1/2 flex-col",
          "rounded border border-line shadow-2xl shadow-black/60 animate-pop-in focus:outline-none",
          className,
        )}
      >
        <div className={cn("flex items-start justify-between gap-4 px-5 py-4", hasBody && "border-b border-line")}>
          <div className="min-w-0">
            <RD.Title className="text-md font-semibold text-fg">{title}</RD.Title>
            {description ? <RD.Description className="mt-1.5 text-sm text-muted">{description}</RD.Description> : null}
          </div>
          {!hideClose ? (
            <RD.Close
              aria-label="Close dialog"
              className="press -mr-1 inline-flex size-8 items-center justify-center rounded text-muted hover:bg-fg/[0.06] hover:text-fg"
            >
              <X className="size-4" aria-hidden />
            </RD.Close>
          ) : null}
        </div>
        {hasBody ? <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div> : null}
        {footer ? <div className="flex flex-wrap items-center justify-end gap-2 border-t border-line px-5 py-3">{footer}</div> : null}
      </RD.Content>
    </RD.Portal>
  );
}
