import { Component, type ReactNode } from "react";
import { ErrorState } from "@/components/ui/Feedback";

interface Props {
  /** Clears the error when it changes (the route), without remounting healthy views. */
  resetKey: string;
  children: ReactNode;
}

/** Keeps the shell (sidebar, top bar) alive when a view throws while rendering. */
export class RouteErrorBoundary extends Component<Props, { error: unknown }> {
  override state: { error: unknown } = { error: null };

  static getDerivedStateFromError(error: unknown) {
    return { error };
  }

  override componentDidUpdate(prev: Props) {
    if (prev.resetKey !== this.props.resetKey && this.state.error) this.setState({ error: null });
  }

  override render() {
    if (this.state.error) {
      return <ErrorState title="This view crashed" error={this.state.error} onRetry={() => this.setState({ error: null })} className="h-full" />;
    }
    return this.props.children;
  }
}
