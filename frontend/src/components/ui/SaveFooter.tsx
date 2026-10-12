import { useState } from "react";
import type { CSSProperties } from "react";
import { AlertTriangle, Check, CheckCircle2, Save } from "lucide-react";

import Button from "./Button";

const tone = (value: string) => ({ "--onb-tone": value }) as CSSProperties;

/** Every tab ends the same way: what changed, any error, and the one save action. */
export default function SaveFooter({
  dirty,
  saving,
  saved,
  error,
  label,
  onSave,
  canManage = true,
  readOnlyNote = "You can view this; changing it needs an admin.",
}: {
  dirty: boolean;
  saving: boolean;
  saved: string | null;
  error: string | null;
  label: string;
  onSave: () => void;
  canManage?: boolean;
  readOnlyNote?: string;
}) {
  if (!canManage) return <div className="th-onb-foot th-onb-hint">{readOnlyNote}</div>;
  return (
    <div className="th-onb-foot th-team-foot">
      <div className="min-w-0 flex-1">
        {error ? (
          <span className="th-team-state" style={tone("var(--th-status-critical)")} role="alert">
            <AlertTriangle className="h-3.5 w-3.5" />
            {error}
          </span>
        ) : saved ? (
          <span className="th-team-state th-fade-in" style={tone("var(--th-status-online)")} role="status">
            <CheckCircle2 className="h-3.5 w-3.5" />
            {saved}
          </span>
        ) : dirty ? (
          <span className="th-team-state" style={tone("var(--th-status-warning)")}>
            <i />
            Unsaved changes
          </span>
        ) : (
          <span className="th-team-state" style={tone("var(--th-text-faint)")}>
            <Check className="h-3.5 w-3.5" />
            Up to date
          </span>
        )}
      </div>
      <Button onClick={onSave} disabled={saving || !dirty}>
        <Save className="h-4 w-4" />
        {saving ? "Saving…" : label}
      </Button>
    </div>
  );
}

export function useSaveState() {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const run = async (action: () => Promise<void>, success: string, failure: string) => {
    try {
      setSaving(true);
      setError(null);
      setSaved(null);
      await action();
      setSaved(success);
      window.setTimeout(() => setSaved(null), 3000);
    } catch (err) {
      setError(err instanceof Error ? err.message : failure);
    } finally {
      setSaving(false);
    }
  };
  return { saving, error, saved, run };
}
