import { useSyncExternalStore } from "react";

/** App-wide UI state (dialogs, palette, mobile sidebar) as a tiny external store: no provider needed. */
export interface UIState {
  newJob: boolean;
  newJobSource: string;
  palette: boolean;
  shortcuts: boolean;
  sidebar: boolean; // mobile/narrow overlay sidebar
}

let state: UIState = { newJob: false, newJobSource: "", palette: false, shortcuts: false, sidebar: false };
const listeners = new Set<() => void>();

export function setUI(patch: Partial<UIState>): void {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
}

export function getUI(): UIState {
  return state;
}

export function useUI(): UIState {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => {
        listeners.delete(l);
      };
    },
    () => state,
    () => state,
  );
}

export const openNewJob = (source = "") => setUI({ newJob: true, newJobSource: source, palette: false });
