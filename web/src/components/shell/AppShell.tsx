import { useEffect, useRef } from "react";
import { Outlet, useLocation, useMatch, useNavigate } from "react-router-dom";
import { Toaster } from "@/components/ui/Toaster";
import { JOB_TABS } from "@/features/registry";
import { useHotkeys } from "@/lib/hotkeys";
import { getUI, openNewJob, setUI } from "@/lib/ui-store";
import { CommandPalette } from "./CommandPalette";
import { NewJobDialog, ShortcutsDialog } from "./GlobalDialogs";
import { RouteErrorBoundary } from "./RouteErrorBoundary";
import { RunWatcher } from "./RunWatcher";
import { Sidebar } from "./Sidebar";
import { TopBar } from "./TopBar";

export function AppShell() {
  const loc = useLocation();
  const navigate = useNavigate();
  const jobMatch = useMatch({ path: "/jobs/:id/*" });
  const jobId = jobMatch?.params.id ?? null;
  const mainRef = useRef<HTMLElement>(null);

  const tabKeys = Object.fromEntries(
    JOB_TABS.filter((t) => t.jobTab?.shortcut).map((t) => [
      t.jobTab!.shortcut!,
      () => {
        if (jobId) navigate(`/jobs/${jobId}${t.jobTab!.path ? `/${t.jobTab!.path}` : ""}`);
      },
    ]),
  );

  useHotkeys({
    "mod+k": () => setUI({ palette: !getUI().palette }),
    n: () => openNewJob(),
    "shift+?": () => setUI({ shortcuts: true }),
    ...tabKeys,
  });

  // Move focus to the main region on route change for screen-reader users, without scrolling.
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    mainRef.current?.focus({ preventScroll: true });
  }, [loc.pathname]);

  return (
    <div className="flex h-full overflow-hidden">
      <a
        href="#main"
        className="fixed left-2 top-2 z-[90] -translate-y-16 rounded bg-accent px-3 py-2 text-sm font-medium text-accent-ink focus:translate-y-0"
      >
        Skip to content
      </a>
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar />
        <main id="main" ref={mainRef} tabIndex={-1} className="relative min-h-0 flex-1 overflow-auto focus:outline-none">
          <RouteErrorBoundary resetKey={loc.pathname}>
            <Outlet />
          </RouteErrorBoundary>
        </main>
      </div>
      <CommandPalette />
      <NewJobDialog />
      <ShortcutsDialog />
      <RunWatcher />
      <Toaster />
    </div>
  );
}
