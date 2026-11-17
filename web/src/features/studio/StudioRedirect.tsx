import { ListChecks } from "lucide-react";
import { Link, Navigate } from "react-router-dom";
import { ApiError } from "@/api/client";
import { useSelection } from "@/api/hooks";
import { EmptyState, ErrorState, SkeletonRows } from "@/components/ui/Feedback";
import { useJobContext } from "@/features/job/context";

/** /jobs/:id/studio → the best clip to look at first (first non-rejected, rendered preferred). */
export default function StudioRedirect() {
  const { job } = useJobContext();
  const sel = useSelection(job.id);
  if (sel.isLoading) return <SkeletonRows rows={4} className="p-6" />;
  if (sel.isError && !(sel.error instanceof ApiError && sel.error.status === 404)) return <ErrorState error={sel.error} onRetry={() => void sel.refetch()} className="py-20" />;
  const cands = sel.data?.candidates ?? [];
  const pick = cands.find((c) => c.approved !== false && c.render.state === "done") ?? cands.find((c) => c.approved !== false) ?? cands[0];
  if (!pick) {
    return (
      <EmptyState
        icon={ListChecks}
        title="No clips to open"
        className="py-20"
        action={
          <Link to={`/jobs/${job.id}`} className="press inline-flex h-8 items-center rounded bg-accent px-3 text-sm font-medium text-accent-ink hover:bg-accent/90">
            Go to the pipeline
          </Link>
        }
      >
        The Studio opens a clip once clip selection has produced candidates.
      </EmptyState>
    );
  }
  return <Navigate to={`/jobs/${job.id}/clips/${pick.id}`} replace />;
}
