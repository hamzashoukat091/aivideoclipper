import { Skeleton } from "@/components/ui/Feedback";

export function PageSkeleton() {
  return (
    <div className="space-y-4 p-6" role="status" aria-label="Loading page">
      <Skeleton className="h-6 w-64" />
      <Skeleton className="h-4 w-96 max-w-full" />
      <div className="grid gap-4 md:grid-cols-3">
        <Skeleton className="h-40" />
        <Skeleton className="h-40" />
        <Skeleton className="h-40" />
      </div>
    </div>
  );
}
