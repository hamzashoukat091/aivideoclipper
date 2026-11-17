import * as RD from "@radix-ui/react-dialog";
import { Command } from "cmdk";
import { Clapperboard, CornerDownLeft, Film } from "lucide-react";
import { useMatch, useNavigate } from "react-router-dom";
import { useJobs, useSelection } from "@/api/hooks";
import { Kbd } from "@/components/ui/Kbd";
import { ALL_COMMANDS, type CommandContext } from "@/features/registry";
import { fmtDuration } from "@/lib/format";
import { setUI, useUI } from "@/lib/ui-store";

const itemCls =
  "flex h-9 cursor-pointer select-none items-center gap-2.5 rounded px-2.5 text-sm text-muted data-[selected=true]:bg-fg/[0.07] data-[selected=true]:text-fg";
const groupCls =
  "[&_[cmdk-group-heading]]:px-2.5 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wider [&_[cmdk-group-heading]]:text-faint";

export function CommandPalette() {
  const ui = useUI();
  const navigate = useNavigate();
  const m = useMatch({ path: "/jobs/:id/*" });
  const jobId = m?.params.id ?? null;
  const jobs = useJobs();
  const selection = useSelection(jobId ?? "", !!jobId && ui.palette);
  const ctx: CommandContext = { navigate, jobId };
  const close = () => setUI({ palette: false });
  const run = (fn: () => void) => {
    close();
    fn();
  };

  return (
    <RD.Root open={ui.palette} onOpenChange={(o) => setUI({ palette: o })}>
      <RD.Portal>
        <RD.Overlay className="fixed inset-0 z-50 bg-black/55 animate-fade-in" />
        <RD.Content className="glass fixed left-1/2 top-[14vh] z-50 w-[calc(100vw-32px)] max-w-xl -translate-x-1/2 overflow-hidden rounded border border-line shadow-2xl shadow-black/60 animate-pop-in focus:outline-none">
          <RD.Title className="sr-only">Command palette</RD.Title>
          <RD.Description className="sr-only">Search commands, jobs and clips. Use arrow keys and Enter.</RD.Description>
          <Command label="Command palette" loop>
      <div className="flex items-center gap-2 border-b border-line px-3">
        <Command.Input
          autoFocus
          placeholder="Type a command, job or clip…"
          className="h-11 w-full bg-transparent text-md text-fg placeholder:text-faint focus:outline-none"
        />
        <Kbd>Esc</Kbd>
      </div>
      <Command.List className="max-h-[min(420px,60vh)] overflow-y-auto p-1.5">
        <Command.Empty className="px-3 py-6 text-center text-sm text-muted">No results.</Command.Empty>
        <Command.Group heading="Commands" className={groupCls}>
          {ALL_COMMANDS.filter((c) => !c.when || c.when(ctx)).map((c) => (
            <Command.Item key={c.id} value={`${c.label} ${(c.keywords ?? []).join(" ")}`} onSelect={() => run(() => c.run(ctx))} className={itemCls}>
              <c.icon className="size-4 shrink-0" aria-hidden />
              <span className="flex-1 truncate">{c.label}</span>
              {c.shortcut ? <Kbd>{c.shortcut}</Kbd> : null}
            </Command.Item>
          ))}
        </Command.Group>
        {jobId && selection.data && selection.data.candidates.length > 0 ? (
          <Command.Group heading="Clips in this job" className={groupCls}>
            {selection.data.candidates.map((c) => (
              <Command.Item
                key={c.id}
                value={`clip ${c.id} ${c.title} ${c.category}`}
                onSelect={() => run(() => navigate(`/jobs/${jobId}/clips/${c.id}`))}
                className={itemCls}
              >
                <Film className="size-4 shrink-0" aria-hidden />
                <span className="font-mono text-xs text-faint">{c.id}</span>
                <span className="flex-1 truncate">{c.title}</span>
                <span className="font-mono text-xs text-faint tnum">{fmtDuration(c.duration)}</span>
              </Command.Item>
            ))}
          </Command.Group>
        ) : null}
        {jobs.data && jobs.data.length > 0 ? (
          <Command.Group heading="Jobs" className={groupCls}>
            {jobs.data.map((j) => (
              <Command.Item key={j.id} value={`job ${j.id} ${j.title} ${j.channel ?? ""}`} onSelect={() => run(() => navigate(`/jobs/${j.id}`))} className={itemCls}>
                <Clapperboard className="size-4 shrink-0" aria-hidden />
                <span className="flex-1 truncate">{j.title || j.id}</span>
                <span className="font-mono text-xs text-faint">{j.id}</span>
              </Command.Item>
            ))}
          </Command.Group>
        ) : null}
      </Command.List>
      <div className="flex items-center gap-3 border-t border-line px-3 py-2 text-xs text-faint">
        <span className="inline-flex items-center gap-1">
          <Kbd>↑</Kbd>
          <Kbd>↓</Kbd> navigate
        </span>
        <span className="inline-flex items-center gap-1">
          <Kbd>
            <CornerDownLeft className="size-3" aria-hidden />
          </Kbd>{" "}
          open
        </span>
      </div>
          </Command>
        </RD.Content>
      </RD.Portal>
    </RD.Root>
  );
}
