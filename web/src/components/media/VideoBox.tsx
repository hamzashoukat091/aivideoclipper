import { AlertTriangle, Loader2 } from "lucide-react";
import { forwardRef, useEffect, useState, type ReactNode, type VideoHTMLAttributes } from "react";
import { cn } from "@/lib/cn";
import { mediaErrorText } from "@/lib/media";

export type MediaStatus = "loading" | "ready" | "error" | "none";

/**
 * <video> with loading + error overlays. Reports status so callers can fall back (proxy copy, virtual clock).
 * The element always keeps its box, so overlays (crop rectangles) can still be drawn when media fails.
 */
export const VideoBox = forwardRef<
  HTMLVideoElement,
  Omit<VideoHTMLAttributes<HTMLVideoElement>, "src"> & {
    src: string | null;
    onStatus?: (s: MediaStatus, v: HTMLVideoElement | null) => void;
    errorAction?: ReactNode;
    emptyContent?: ReactNode;
    boxClassName?: string;
    label: string;
    children?: ReactNode;
  }
>(function VideoBox({ src, onStatus, errorAction, emptyContent, className, boxClassName, label, children, ...rest }, ref) {
  const [status, setStatus] = useState<MediaStatus>(src ? "loading" : "none");
  const [errText, setErrText] = useState("");

  useEffect(() => {
    const s: MediaStatus = src ? "loading" : "none";
    setStatus(s);
    onStatus?.(s, null);
    // onStatus identity is not part of the media lifecycle
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src]);

  return (
    <div className={cn("relative overflow-hidden bg-black", boxClassName)}>
      {src ? (
        <video
          ref={ref}
          src={src}
          aria-label={label}
          preload="auto"
          playsInline
          className={cn("absolute inset-0 size-full object-contain", className)}
          onLoadedData={(e) => {
            setStatus("ready");
            onStatus?.("ready", e.currentTarget);
          }}
          onError={(e) => {
            setErrText(mediaErrorText(e.currentTarget));
            setStatus("error");
            onStatus?.("error", e.currentTarget);
          }}
          {...rest}
        />
      ) : null}
      {children}
      {status === "loading" ? (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center" role="status" aria-label="Loading video">
          <Loader2 className="size-6 animate-spin text-muted" aria-hidden />
        </div>
      ) : null}
      {status === "error" ? (
        <div className="absolute inset-x-0 bottom-0 flex flex-col items-center gap-2 bg-gradient-to-t from-black/90 via-black/70 to-transparent px-4 pb-4 pt-10 text-center">
          <span className="inline-flex items-center gap-1.5 text-sm text-fg">
            <AlertTriangle className="size-4 text-warn" aria-hidden /> Video unavailable
          </span>
          <span className="max-w-sm text-xs text-muted">{errText}</span>
          {errorAction}
        </div>
      ) : null}
      {status === "none" && emptyContent ? <div className="absolute inset-0 flex items-center justify-center p-4">{emptyContent}</div> : null}
    </div>
  );
});
