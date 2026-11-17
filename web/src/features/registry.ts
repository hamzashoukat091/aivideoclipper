/**
 * Feature registry (UI_SPEC section 5, "Room for features"). The sidebar, the job tabs, the routes and the ⌘K
 * palette are all generated from this array. Adding a feature = a folder under src/features/<name>/ + one entry.
 */
import {
  Activity,
  Clapperboard,
  FileStack,
  FolderTree,
  History,
  Keyboard,
  LayoutGrid,
  ListChecks,
  Plus,
  Settings,
  Workflow,
  type LucideIcon,
} from "lucide-react";
import { lazy, type ComponentType, type LazyExoticComponent } from "react";
import type { NavigateFunction } from "react-router-dom";
import { openNewJob, setUI } from "@/lib/ui-store";

export interface CommandContext {
  navigate: NavigateFunction;
  jobId: string | null;
}

export interface FeatureCommand {
  id: string;
  label: string;
  keywords?: string[];
  shortcut?: string;
  /** Overrides the feature's icon in the palette. */
  icon?: LucideIcon;
  /** Hide unless this returns true (e.g. job-scoped commands). */
  when?: (ctx: CommandContext) => boolean;
  run: (ctx: CommandContext) => void;
}

export interface Feature {
  id: string;
  label: string;
  icon: LucideIcon;
  /** Top-level route, shown in the sidebar nav. */
  route?: string;
  /** Tab inside a job: path segment under /jobs/:id ("" = overview). */
  jobTab?: { path: string; shortcut?: string };
  /** Lazily loaded screen for `route` or `jobTab`. */
  component?: LazyExoticComponent<ComponentType>;
  /** Extra routes under /jobs/:id served by this feature (e.g. clips/:cid). */
  extraJobRoutes?: { path: string; component: LazyExoticComponent<ComponentType> }[];
  commands?: FeatureCommand[];
}

const hasJob = (c: CommandContext) => c.jobId !== null;
const goTab = (path: string) => (c: CommandContext) => {
  if (c.jobId) c.navigate(`/jobs/${c.jobId}${path ? `/${path}` : ""}`);
};

export const FEATURES: Feature[] = [
  {
    id: "library",
    label: "Library",
    icon: LayoutGrid,
    route: "/",
    component: lazy(() => import("./library/LibraryPage")),
    commands: [
      { id: "new-job", label: "New job…", icon: Plus, keywords: ["create", "add", "youtube", "url", "import"], shortcut: "N", run: () => openNewJob() },
      { id: "go-library", label: "Go to Library", keywords: ["home", "jobs"], run: (c) => c.navigate("/") },
    ],
  },
  {
    id: "activity",
    label: "Activity",
    icon: Activity,
    route: "/activity",
    component: lazy(() => import("./activity/ActivityPage")),
    commands: [{ id: "go-activity", label: "Go to Activity", keywords: ["runs", "queue", "logs"], run: (c) => c.navigate("/activity") }],
  },
  {
    id: "settings",
    label: "Settings",
    icon: Settings,
    route: "/settings",
    component: lazy(() => import("./settings/SettingsPage")),
    commands: [
      { id: "go-settings", label: "Go to Settings", keywords: ["system", "keys", "tools", "defaults", "spend"], run: (c) => c.navigate("/settings") },
      { id: "shortcuts", label: "Keyboard shortcuts", icon: Keyboard, keywords: ["help", "keys"], shortcut: "?", run: () => setUI({ shortcuts: true, palette: false }) },
    ],
  },
  {
    id: "overview",
    label: "Overview",
    icon: Workflow,
    jobTab: { path: "", shortcut: "1" },
    component: lazy(() => import("./overview/OverviewPage")),
    commands: [{ id: "tab-overview", label: "Job: Overview (pipeline)", keywords: ["stages", "pipeline", "console"], when: hasJob, run: goTab("") }],
  },
  {
    id: "source",
    label: "Source",
    icon: Clapperboard,
    jobTab: { path: "source", shortcut: "2" },
    component: lazy(() => import("./source/SourcePage")),
    commands: [{ id: "tab-source", label: "Job: Source & transcript", keywords: ["player", "heatmap", "transcript"], when: hasJob, run: goTab("source") }],
  },
  {
    id: "clips",
    label: "Clips",
    icon: ListChecks,
    jobTab: { path: "clips", shortcut: "3" },
    component: lazy(() => import("./clips/ClipsPage")),
    commands: [{ id: "tab-clips", label: "Job: Clips review", keywords: ["approve", "reject", "candidates"], when: hasJob, run: goTab("clips") }],
  },
  {
    id: "studio",
    label: "Studio",
    icon: FileStack,
    jobTab: { path: "studio", shortcut: "4" },
    component: lazy(() => import("./studio/StudioRedirect")),
    extraJobRoutes: [{ path: "clips/:cid", component: lazy(() => import("./studio/StudioPage")) }],
    commands: [{ id: "tab-studio", label: "Job: Studio player", keywords: ["player", "crop", "render", "9:16"], when: hasJob, run: goTab("studio") }],
  },
  {
    id: "files",
    label: "Files",
    icon: FolderTree,
    jobTab: { path: "files", shortcut: "5" },
    component: lazy(() => import("./files/FilesPage")),
    commands: [{ id: "tab-files", label: "Job: Files", keywords: ["json", "download", "browser"], when: hasJob, run: goTab("files") }],
  },
  {
    id: "runs",
    label: "Runs",
    icon: History,
    jobTab: { path: "runs", shortcut: "6" },
    component: lazy(() => import("./runs/RunsPage")),
    commands: [{ id: "tab-runs", label: "Job: Run history", keywords: ["logs", "history", "commands"], when: hasJob, run: goTab("runs") }],
  },
];

export const NAV_FEATURES = FEATURES.filter((f) => f.route);
export const JOB_TABS = FEATURES.filter((f) => f.jobTab);
export const ALL_COMMANDS = FEATURES.flatMap((f) => (f.commands ?? []).map((c) => ({ ...c, icon: c.icon ?? f.icon, feature: f.id })));
