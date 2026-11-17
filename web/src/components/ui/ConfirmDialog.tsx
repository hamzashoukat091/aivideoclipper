import { useRef, type ReactNode } from "react";
import { Button } from "./Button";
import { DialogContent, DialogRoot } from "./Dialog";

export function ConfirmDialog({
  open,
  title,
  children,
  confirmLabel,
  onConfirm,
  onOpenChange,
  tone = "primary",
}: {
  open: boolean;
  title: string;
  children: ReactNode;
  confirmLabel: string;
  onConfirm: () => void;
  onOpenChange: (o: boolean) => void;
  tone?: "primary" | "danger";
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  return (
    <DialogRoot open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title={title}
        description={children}
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          cancelRef.current?.focus();
        }}
        footer={
          <>
            <Button ref={cancelRef} variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button
              variant={tone === "danger" ? "danger" : "primary"}
              onClick={() => {
                onOpenChange(false);
                onConfirm();
              }}
            >
              {confirmLabel}
            </Button>
          </>
        }
      />
    </DialogRoot>
  );
}
