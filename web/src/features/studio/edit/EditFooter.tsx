import { Redo2, Undo2 } from "lucide-react";
import type { EditContext } from "@/api/types";
import { Button, IconButton } from "@/components/ui/Button";
import { MOD } from "@/lib/platform";

/**
 * The editor's only status line (UI_SPEC 5b): "Unsaved changes · Discard · Save", then after saving
 * "Render to apply · Final / Fast" (or the reframe notice when the added part needs re-analysis).
 */
export function EditFooter({
  ctx,
  dirty,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  onDiscard,
  onSave,
  saving,
  saveBlocked,
  busy,
  onRender,
}: {
  ctx: EditContext;
  dirty: boolean;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  onDiscard: () => void;
  onSave: () => void;
  saving: boolean;
  saveBlocked: string | null;
  busy: boolean;
  onRender: (fast: boolean, withReframe: boolean) => void;
}) {
  const needsReframe = ctx.needs.includes("reframe");
  const needsRender = ctx.needs.length > 0;
  return (
    <div className="flex min-h-8 flex-wrap items-center gap-x-3 gap-y-2 text-sm" aria-live="polite">
      <div className="flex items-center">
        <IconButton size="sm" label="Undo" shortcut={`${MOD}Z`} disabled={!canUndo} onClick={onUndo}>
          <Undo2 className="size-3.5" aria-hidden />
        </IconButton>
        <IconButton size="sm" label="Redo" shortcut={`${MOD}⇧Z`} disabled={!canRedo} onClick={onRedo}>
          <Redo2 className="size-3.5" aria-hidden />
        </IconButton>
      </div>
      {dirty ? (
        <>
          <span className="text-muted">Unsaved changes</span>
          {saveBlocked ? <span className="text-xs text-bad">{saveBlocked}</span> : null}
          <div className="ml-auto flex items-center gap-2">
            <Button size="sm" variant="ghost" onClick={onDiscard} disabled={saving}>
              Discard
            </Button>
            <Button size="sm" variant="primary" onClick={onSave} loading={saving} disabled={!!saveBlocked} title={`Save edits (${MOD}S). The video updates when you render.`}>
              Save
            </Button>
          </div>
        </>
      ) : needsRender ? (
        <>
          <span className="text-muted">{needsReframe ? "Framing for the added part needs re-analysis, ~2 min" : "Render to apply"}</span>
          <div className="ml-auto flex items-center gap-2">
            <Button size="sm" variant="primary" disabled={busy} onClick={() => onRender(false, needsReframe)}>
              {needsReframe ? "Reframe + render" : "Render final"}
            </Button>
            <Button size="sm" disabled={busy} onClick={() => onRender(true, needsReframe)} title={needsReframe ? "Reframe, then a quicker encode for checking" : "Quicker encode for checking"}>
              {needsReframe ? "Fast" : "Render fast"}
            </Button>
          </div>
        </>
      ) : null}
    </div>
  );
}
