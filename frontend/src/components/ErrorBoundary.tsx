import { Component, ErrorInfo, ReactNode } from "react";
import { AlertTriangle, RefreshCcw } from "lucide-react";
import { Button, EmptyState } from "./ui";
import { reportError } from "../utils/errorReporting";

interface ErrorBoundaryProps {
  children: ReactNode;
  /** When this value changes the boundary clears its error, e.g. the route path. */
  resetKey?: unknown;
  /** "page" renders inside the shell; "app" owns the whole viewport. */
  scope?: "page" | "app";
}

interface ErrorBoundaryState {
  error: Error | null;
}

const CHUNK_RELOAD_KEY = "techi.chunk-reload-at";

/**
 * A lazy route chunk that no longer exists on the server — the tab was opened
 * before a deploy replaced the hashed bundles. Reloading fetches the new
 * index.html and its chunks; this is the only error a reload reliably fixes.
 */
export function isChunkLoadError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return /dynamically imported module|Importing a module script failed|Loading chunk [\w-]+ failed|error loading dynamically imported module/i.test(
    error.message,
  );
}

function reloadOnceForChunk(): boolean {
  try {
    const last = Number(window.sessionStorage.getItem(CHUNK_RELOAD_KEY) || 0);
    // One automatic reload per minute: a chunk still missing after a fresh
    // index.html is a real outage, and looping would hide it.
    if (Date.now() - last < 60_000) return false;
    window.sessionStorage.setItem(CHUNK_RELOAD_KEY, String(Date.now()));
  } catch {
    return false;
  }
  window.location.reload();
  return true;
}

/**
 * Catches render errors so one broken component shows a recoverable message
 * instead of a blank white page. A page-scoped boundary keeps the sidebar and
 * top bar usable, and clears itself on navigation.
 */
export default class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    if (isChunkLoadError(error) && reloadOnceForChunk()) return;
    reportError(error, { componentStack: info.componentStack ?? undefined, scope: this.props.scope ?? "page" });
  }

  componentDidUpdate(prev: ErrorBoundaryProps): void {
    if (this.state.error && prev.resetKey !== this.props.resetKey) {
      this.setState({ error: null });
    }
  }

  private retry = () => this.setState({ error: null });

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    const chunk = isChunkLoadError(error);
    const app = this.props.scope === "app";
    return (
      <div
        role="alert"
        className={
          app
            ? "flex min-h-screen items-center justify-center p-6"
            : "flex min-h-[50vh] items-center justify-center p-6"
        }
        style={app ? { background: "var(--th-bg-main)" } : undefined}
      >
        <EmptyState
          icon={<AlertTriangle className="h-5 w-5" aria-hidden />}
          title={chunk ? "A new version is available" : "Something went wrong on this page"}
          description={
            chunk
              ? "The platform was updated while this tab was open. Reload to continue."
              : "The error was recorded. Try again, or reload the page if it keeps happening."
          }
          action={
            <div className="flex flex-wrap justify-center gap-2">
              {!chunk && (
                <Button variant="secondary" size="sm" onClick={this.retry}>
                  Try again
                </Button>
              )}
              <Button size="sm" onClick={() => window.location.reload()}>
                <RefreshCcw className="h-4 w-4" aria-hidden /> Reload
              </Button>
            </div>
          }
        />
      </div>
    );
  }
}
