import * as RToast from "@radix-ui/react-toast";
import { CheckCircle2, Info, Loader2, X, XCircle } from "lucide-react";
import { Link } from "react-router-dom";
import { cn } from "@/lib/cn";
import { dismissToast, useToasts, type ToastTone } from "@/lib/toast";

const TONE: Record<ToastTone, { icon: typeof Info; cls: string }> = {
  info: { icon: Info, cls: "text-muted" },
  success: { icon: CheckCircle2, cls: "text-ok" },
  error: { icon: XCircle, cls: "text-bad" },
  running: { icon: Loader2, cls: "text-run animate-spin" },
};

export function Toaster() {
  const toasts = useToasts();
  return (
    <RToast.Provider swipeDirection="right">
      {toasts.map((t) => {
        const { icon: Icon, cls } = TONE[t.tone];
        return (
          <RToast.Root
            key={t.id}
            duration={t.duration}
            onOpenChange={(open) => {
              if (!open) dismissToast(t.id);
            }}
            className={cn(
              "glass pointer-events-auto flex w-full items-start gap-3 rounded border border-line p-3 shadow-xl shadow-black/50",
              "data-[state=open]:animate-pop-in data-[swipe=move]:translate-x-[var(--radix-toast-swipe-move-x)]",
            )}
          >
            <Icon className={cn("mt-0.5 size-4 shrink-0", cls)} aria-hidden />
            <div className="min-w-0 flex-1">
              <RToast.Title className="text-sm font-medium text-fg">{t.title}</RToast.Title>
              {t.description ? <RToast.Description className="mt-0.5 break-words text-xs text-muted">{t.description}</RToast.Description> : null}
              {t.href ? (
                <RToast.Action asChild altText={t.hrefLabel ?? "Open"}>
                  <Link to={t.href} className="mt-1.5 inline-block text-xs font-medium text-accent hover:underline">
                    {t.hrefLabel ?? "Open"}
                  </Link>
                </RToast.Action>
              ) : null}
            </div>
            <RToast.Close aria-label="Dismiss notification" className="press -m-1 rounded p-1 text-muted hover:text-fg">
              <X className="size-3.5" aria-hidden />
            </RToast.Close>
          </RToast.Root>
        );
      })}
      <RToast.Viewport className="fixed bottom-4 right-4 z-[80] flex w-[360px] max-w-[calc(100vw-32px)] flex-col gap-2 outline-none" />
    </RToast.Provider>
  );
}
