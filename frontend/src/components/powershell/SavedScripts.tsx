import { useState } from "react";
import { FileCode2, Play } from "lucide-react";
import type { ConsoleScript } from "../../api/terminal";
import { Button, Modal } from "../ui";
import { PanelSection } from "./parts";

const TOP = 5;

/** The most-used scripts first; ties by name. */
export function topScripts(scripts: ConsoleScript[], n = TOP): ConsoleScript[] {
  return [...scripts].sort((a, b) => b.uses - a.uses || a.name.localeCompare(b.name)).slice(0, n);
}

export function ScriptRunModal({
  script,
  deviceName,
  onRun,
  onClose,
}: {
  script: ConsoleScript;
  deviceName: string;
  /** Rejects with the reason it could not run. */
  onRun: () => Promise<void>;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      await onRun();
      onClose();
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : "Couldn't run the script.");
      setBusy(false);
    }
  };
  return (
    <Modal
      title={`Run “${script.name}”`}
      subtitle={`${deviceName} · v${script.version} · runs as SYSTEM in this session`}
      icon={FileCode2}
      tone="warning"
      size="lg"
      busy={busy}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" size="sm" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button size="sm" onClick={() => void run()} disabled={busy} data-autofocus>
            <Play className="h-3.5 w-3.5" />
            {busy ? "Running…" : "Run as SYSTEM"}
          </Button>
        </>
      }
    >
      {script.description && (
        <p className="mb-3 text-[13px]" style={{ color: "var(--th-text-secondary)" }}>
          {script.description}
        </p>
      )}
      <textarea
        readOnly
        className="ps-code w-full resize-none"
        aria-label="Script body"
        value={script.body}
        rows={Math.min(18, Math.max(3, script.body.split("\n").length))}
        spellCheck={false}
        wrap="off"
      />
      {error && (
        <p role="alert" className="th-drawer-callout mt-3 text-[13px]" data-tone="critical">
          {error}
        </p>
      )}
    </Modal>
  );
}

/** Side panel: the top saved scripts, each one click (and a confirmation) from running. */
export default function SavedScripts({
  scripts,
  loading,
  error,
  canRun,
  onRun,
  onOpenLibrary,
  className,
}: {
  scripts: ConsoleScript[] | undefined;
  loading: boolean;
  error: string | null;
  canRun: boolean;
  onRun: (script: ConsoleScript) => void;
  onOpenLibrary: () => void;
  className?: string;
}) {
  const top = topScripts(scripts ?? []);
  return (
    <PanelSection
      title="Saved scripts"
      className={className}
      action={
        <button type="button" className="ps-link" onClick={onOpenLibrary}>
          Library
        </button>
      }
    >
      {loading ? (
        <div className="space-y-1.5" aria-hidden="true">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-9 animate-pulse rounded-md" style={{ background: "var(--th-ring-track)" }} />
          ))}
        </div>
      ) : error && !scripts ? (
        <p className="ps-empty" style={{ color: "var(--th-status-critical)" }}>
          Couldn't load saved scripts.
        </p>
      ) : top.length === 0 ? (
        <p className="ps-empty">No saved scripts yet. Add one in the Library.</p>
      ) : (
        <ul aria-label="Saved scripts" className="ps-scripts">
          {top.map((s) => (
            <li key={s.id} className="ps-script">
              <div className="min-w-0 flex-1">
                <p className="ps-script-name">{s.name}</p>
                <p className="ps-script-desc">{s.description || "No description"}</p>
              </div>
              <button
                type="button"
                className="ps-script-run"
                disabled={!canRun}
                onClick={() => onRun(s)}
                aria-label={`Run ${s.name}`}
                title={canRun ? `Run ${s.name}` : "Open a session to run scripts"}
              >
                <Play className="h-3 w-3" aria-hidden="true" />
                Run
              </button>
            </li>
          ))}
        </ul>
      )}
    </PanelSection>
  );
}
