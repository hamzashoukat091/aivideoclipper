import { Film } from "lucide-react";
import { useState } from "react";
import { cn } from "@/lib/cn";

/** 16:9 thumbnail with a graceful placeholder when the image is missing or fails. */
export function JobThumb({ url, alt, className, iconSize = "size-5" }: { url: string | null; alt: string; className?: string; iconSize?: string }) {
  const [failed, setFailed] = useState<string | null>(null);
  const show = url && failed !== url;
  return (
    <div className={cn("relative aspect-video shrink-0 overflow-hidden rounded-sm bg-panel2", className)}>
      {show ? (
        <img src={url} alt={alt} loading="lazy" decoding="async" onError={() => setFailed(url)} className="absolute inset-0 size-full object-cover" />
      ) : (
        <div className="absolute inset-0 flex items-center justify-center bg-[linear-gradient(135deg,rgb(var(--panel-2)),rgb(var(--raised)))]">
          <Film className={cn("text-faint", iconSize)} aria-hidden />
        </div>
      )}
    </div>
  );
}
