import { DialogContent, DialogRoot } from "@/components/ui/Dialog";
import { Kbd } from "@/components/ui/Kbd";
import { MOD } from "@/lib/platform";
import { setUI, useUI } from "@/lib/ui-store";
import { NewJobForm } from "./NewJobForm";

export function NewJobDialog() {
  const ui = useUI();
  return (
    <DialogRoot open={ui.newJob} onOpenChange={(o) => setUI({ newJob: o })}>
      <DialogContent title="New job" description="Turn a long video into vertical clips. Nothing paid runs from here." className="max-w-xl">
        {ui.newJob ? <NewJobForm autoFocus initialSource={ui.newJobSource} onDone={() => setUI({ newJob: false })} onCancel={() => setUI({ newJob: false })} /> : null}
      </DialogContent>
    </DialogRoot>
  );
}

const SHORTCUTS: { group: string; items: [string[], string][] }[] = [
  {
    group: "Global",
    items: [
      [[MOD, "K"], "Command palette"],
      [["N"], "New job"],
      [["?"], "This list"],
      [["1", "…", "6"], "Job tabs (inside a job)"],
    ],
  },
  {
    group: "Clips review",
    items: [
      [["J"], "Next clip"],
      [["K"], "Previous clip"],
      [["A"], "Approve focused clip"],
      [["R"], "Reject focused clip"],
      [["U"], "Mark undecided"],
      [["Enter"], "Open in Studio"],
      [["X"], "Expand / collapse details"],
    ],
  },
  {
    group: "Players",
    items: [
      [["Space"], "Play / pause"],
      [["←", "→"], "Step one frame (Shift: 1 s)"],
      [["L"], "Toggle loop (Studio)"],
      [["J", "K"], "Next / previous clip (Studio)"],
      [["A", "R"], "Approve / reject (Studio)"],
    ],
  },
];

export function ShortcutsDialog() {
  const ui = useUI();
  return (
    <DialogRoot open={ui.shortcuts} onOpenChange={(o) => setUI({ shortcuts: o })}>
      <DialogContent title="Keyboard shortcuts" className="max-w-lg">
        <div className="space-y-5">
          {SHORTCUTS.map((g) => (
            <section key={g.group}>
              <h3 className="mb-2 text-xs font-medium uppercase tracking-wider text-faint">{g.group}</h3>
              <ul className="space-y-1.5">
                {g.items.map(([keys, what]) => (
                  <li key={what} className="flex items-center justify-between gap-4 text-sm">
                    <span className="text-muted">{what}</span>
                    <span className="flex shrink-0 gap-1">
                      {keys.map((k, i) => (k === "…" ? <span key={i} className="text-faint">…</span> : <Kbd key={i}>{k}</Kbd>))}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </DialogContent>
    </DialogRoot>
  );
}
