import { useSyncExternalStore } from "react";

/** User defaults (UI_SPEC section 5.10), saved in localStorage. */
export type JudgeModel = "haiku" | "sonnet" | "opus";
export interface Defaults {
  judgeModel: JudgeModel;
  topN: number;
  fastRenders: boolean;
  previewReframes: boolean;
  autoScrollLogs: boolean;
}

const KEY = "clipper-studio.defaults.v1";
export const DEFAULTS: Defaults = {
  judgeModel: "sonnet",
  topN: 10,
  fastRenders: false,
  previewReframes: false,
  autoScrollLogs: true,
};

function isJudge(v: unknown): v is JudgeModel {
  return v === "haiku" || v === "sonnet" || v === "opus";
}

function read(): Defaults {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return DEFAULTS;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return DEFAULTS;
    const p = parsed as Record<string, unknown>;
    return {
      judgeModel: isJudge(p.judgeModel) ? p.judgeModel : DEFAULTS.judgeModel,
      topN: typeof p.topN === "number" && p.topN >= 1 && p.topN <= 50 ? Math.round(p.topN) : DEFAULTS.topN,
      fastRenders: typeof p.fastRenders === "boolean" ? p.fastRenders : DEFAULTS.fastRenders,
      previewReframes: typeof p.previewReframes === "boolean" ? p.previewReframes : DEFAULTS.previewReframes,
      autoScrollLogs: typeof p.autoScrollLogs === "boolean" ? p.autoScrollLogs : DEFAULTS.autoScrollLogs,
    };
  } catch {
    return DEFAULTS;
  }
}

let current: Defaults = typeof window === "undefined" ? DEFAULTS : read();
const listeners = new Set<() => void>();

export function setDefaults(patch: Partial<Defaults>): void {
  current = { ...current, ...patch };
  try {
    window.localStorage.setItem(KEY, JSON.stringify(current));
  } catch {
    /* storage may be unavailable (private mode): keep the value in memory */
  }
  listeners.forEach((l) => l());
}

export function resetDefaults(): void {
  setDefaults(DEFAULTS);
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

export function useDefaults(): Defaults {
  return useSyncExternalStore(subscribe, () => current, () => DEFAULTS);
}

export const JUDGE_MODELS: { id: JudgeModel; label: string; tradeoff: string }[] = [
  { id: "haiku", label: "Haiku", tradeoff: "Cheapest, but too strict in tests: it rejected every clip, even the best one." },
  { id: "sonnet", label: "Sonnet", tradeoff: "Default. Sound keep/reject calls at about half the cost of Opus." },
  { id: "opus", label: "Opus", tradeoff: "Best judgement in tests, at about 2× the cost of Sonnet." },
];
