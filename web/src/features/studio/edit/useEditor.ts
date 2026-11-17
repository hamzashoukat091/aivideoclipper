import { useCallback, useEffect, useMemo, useState } from "react";
import type { EditContext, Edits } from "@/api/types";
import { sameEdits } from "@/lib/editing";

interface History {
  past: Edits[];
  present: Edits;
  future: Edits[];
  lastKey: string | null;
  lastAt: number;
}

/** Unsaved drafts survive navigating between clips/tabs (in memory, this browser tab only). */
const drafts = new Map<string, { base: string; hist: History }>();

const fresh = (e: Edits): History => ({ past: [], present: e, future: [], lastKey: null, lastAt: 0 });
const MAX_HISTORY = 200;
const COALESCE_MS = 800;

/**
 * Draft state for one clip's edits with undo/redo inside the unsaved session (UI_SPEC 5b).
 * Consecutive changes with the same `key` (typing, dragging) within 800 ms collapse into one undo step.
 */
export function useEditor(jobId: string, cid: string, ctx: EditContext | undefined) {
  const id = `${jobId}/${cid}`;
  const base = ctx ? JSON.stringify(ctx.edits) : null;
  const [hist, setHist] = useState<History | null>(null);

  useEffect(() => {
    if (!ctx || base === null) return;
    const kept = drafts.get(id);
    setHist(kept && kept.base === base ? kept.hist : fresh(ctx.edits));
    // re-initialise only when the saved edits change
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, base]);

  useEffect(() => {
    if (hist && base !== null) drafts.set(id, { base, hist });
  }, [hist, id, base]);

  const update = useCallback((fn: (e: Edits) => Edits, key?: string) => {
    setHist((h) => {
      if (!h) return h;
      const next = fn(h.present);
      if (sameEdits(next, h.present)) return h;
      const now = Date.now();
      if (key && key === h.lastKey && now - h.lastAt < COALESCE_MS) return { ...h, present: next, future: [], lastAt: now };
      return { past: [...h.past, h.present].slice(-MAX_HISTORY), present: next, future: [], lastKey: key ?? null, lastAt: now };
    });
  }, []);

  const undo = useCallback(() => {
    setHist((h) => (h && h.past.length ? { past: h.past.slice(0, -1), present: h.past[h.past.length - 1], future: [h.present, ...h.future], lastKey: null, lastAt: 0 } : h));
  }, []);
  const redo = useCallback(() => {
    setHist((h) => (h && h.future.length ? { past: [...h.past, h.present], present: h.future[0], future: h.future.slice(1), lastKey: null, lastAt: 0 } : h));
  }, []);
  const discard = useCallback(() => {
    if (ctx) setHist(fresh(ctx.edits));
  }, [ctx]);

  const dirty = useMemo(() => !!hist && !!ctx && !sameEdits(hist.present, ctx.edits), [hist, ctx]);

  return {
    draft: hist?.present ?? null,
    update,
    undo,
    redo,
    discard,
    dirty,
    canUndo: !!hist?.past.length,
    canRedo: !!hist?.future.length,
  };
}

export type Editor = ReturnType<typeof useEditor>;
