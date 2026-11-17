import { useSyncExternalStore } from "react";

export type ToastTone = "info" | "success" | "error" | "running";
export interface ToastItem {
  id: number;
  tone: ToastTone;
  title: string;
  description?: string;
  href?: string;
  hrefLabel?: string;
  duration: number;
}

let items: ToastItem[] = [];
let seq = 1;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export function toast(t: Omit<ToastItem, "id" | "duration"> & { duration?: number }): number {
  const id = seq++;
  items = [...items.slice(-4), { ...t, id, duration: t.duration ?? (t.tone === "error" ? 8000 : 4500) }];
  emit();
  return id;
}

export function dismissToast(id: number): void {
  items = items.filter((t) => t.id !== id);
  emit();
}

export function useToasts(): ToastItem[] {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => {
        listeners.delete(l);
      };
    },
    () => items,
    () => items,
  );
}
