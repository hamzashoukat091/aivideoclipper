import * as RT from "@radix-ui/react-tooltip";
import type { ReactNode } from "react";
import { Kbd } from "./Kbd";

export const TooltipProvider = RT.Provider;

export function Tooltip({
  content,
  shortcut,
  side = "top",
  children,
  disabled,
}: {
  content: ReactNode;
  shortcut?: string;
  side?: "top" | "bottom" | "left" | "right";
  children: ReactNode;
  disabled?: boolean;
}) {
  if (disabled || content === null || content === undefined || content === "") return <>{children}</>;
  return (
    <RT.Root>
      <RT.Trigger asChild>{children}</RT.Trigger>
      <RT.Portal>
        <RT.Content
          side={side}
          sideOffset={6}
          collisionPadding={8}
          className="z-[70] max-w-xs animate-pop-in rounded border border-line bg-raised px-2 py-1 text-xs text-fg shadow-lg shadow-black/40"
        >
          <span className="inline-flex items-center gap-2">
            <span>{content}</span>
            {shortcut ? <Kbd>{shortcut}</Kbd> : null}
          </span>
        </RT.Content>
      </RT.Portal>
    </RT.Root>
  );
}
