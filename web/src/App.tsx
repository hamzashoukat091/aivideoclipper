import { Suspense, type ComponentType, type LazyExoticComponent } from "react";
import { Route, Routes } from "react-router-dom";
import { AppShell } from "@/components/shell/AppShell";
import { NotFound } from "@/components/shell/NotFound";
import { PageSkeleton } from "@/components/shell/PageSkeleton";
import { JobLayout } from "@/features/job/JobLayout";
import { JOB_TABS, NAV_FEATURES } from "@/features/registry";

function Lazy({ C }: { C: LazyExoticComponent<ComponentType> }) {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <C />
    </Suspense>
  );
}

export function App() {
  return (
    <Routes>
      <Route element={<AppShell />}>
        {NAV_FEATURES.map((f) =>
          f.component ? (
            f.route === "/" ? <Route key={f.id} index element={<Lazy C={f.component} />} /> : <Route key={f.id} path={f.route} element={<Lazy C={f.component} />} />
          ) : null,
        )}
        <Route path="jobs/:id" element={<JobLayout />}>
          {JOB_TABS.map((f) =>
            f.component && f.jobTab ? (
              f.jobTab.path === "" ? <Route key={f.id} index element={<Lazy C={f.component} />} /> : <Route key={f.id} path={f.jobTab.path} element={<Lazy C={f.component} />} />
            ) : null,
          )}
          {JOB_TABS.flatMap((f) => (f.extraJobRoutes ?? []).map((r) => <Route key={`${f.id}:${r.path}`} path={r.path} element={<Lazy C={r.component} />} />))}
          <Route path="*" element={<NotFound />} />
        </Route>
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  );
}
