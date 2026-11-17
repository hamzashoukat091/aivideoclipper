import { Compass } from "lucide-react";
import { Link } from "react-router-dom";
import { EmptyState } from "@/components/ui/Feedback";

export function NotFound() {
  return (
    <EmptyState
      icon={Compass}
      title="Page not found"
      className="py-24"
      action={
        <Link to="/" className="press inline-flex h-8 items-center rounded bg-accent px-3 text-sm font-medium text-accent-ink hover:bg-accent/90">
          Back to Library
        </Link>
      }
    >
      Nothing lives at this address. Use the sidebar or press the command palette shortcut to jump somewhere.
    </EmptyState>
  );
}
