import { useEffect, useRef } from "react";

export function isTypingTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  if (t.isContentEditable) return true;
  const tag = t.tagName;
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  if (tag === "INPUT") {
    const type = (t as HTMLInputElement).type;
    return !["checkbox", "radio", "button", "range", "submit", "reset"].includes(type);
  }
  return false;
}

function dialogOpen(): boolean {
  return !!document.querySelector('[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"]');
}

export type HotkeyMap = Record<string, (e: KeyboardEvent) => void>;

/**
 * Keys: "k", "shift+?", "mod+k", "mod+shift+z", "space", "arrowleft", "enter", ... ("mod" = Ctrl or ⌘).
 * Plain keys are ignored while typing in a field or while a dialog is open; "mod+" combos always fire.
 */
export function useHotkeys(map: HotkeyMap, enabled = true): void {
  const ref = useRef(map);
  ref.current = map;
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing) return;
      const mod = e.ctrlKey || e.metaKey;
      let key = e.key === " " ? "space" : e.key.toLowerCase();
      if (key === "?") key = "shift+?";
      const combo = mod ? `mod+${e.shiftKey ? "shift+" : ""}${key}` : e.altKey ? `alt+${key}` : key;
      const fn = ref.current[combo];
      if (!fn) return;
      if (!mod && (isTypingTarget(e.target) || dialogOpen())) return;
      // inside a text field, undo/redo stay native
      if (mod && /^mod\+(shift\+)?[zy]$/.test(combo) && isTypingTarget(e.target)) return;
      // space/enter on a focused control keep their native meaning
      if ((combo === "space" || combo === "enter") && e.target instanceof HTMLElement && e.target.closest("button, a, video, audio, [role=button], [role=switch], [role=radio], [role=tab], [role=slider]")) return;
      // arrows/Home/End on a slider, radio group, tab list or menu move that control, not the playhead
      if (
        /^(shift\+)?(arrow\w+|home|end)$/.test(combo) &&
        e.target instanceof HTMLElement &&
        e.target.closest("input, select, video, audio, [role=slider], [role=radio], [role=tab], [role=menuitem], [role=option], [role=listbox]")
      )
        return;
      e.preventDefault();
      fn(e);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [enabled]);
}
