import { useState } from "react";
import type { CSSProperties } from "react";
import { AlertTriangle, Plus } from "lucide-react";

import { createMonitoringPolicy } from "../../api/monitoring";
import type { MonitoringPolicy, PolicyScope } from "../../api/monitoring";
import Button from "../ui/Button";
import Modal from "../ui/Modal";
import ScopePicker from "./ScopePicker";
import { blankBody, ScopeNames } from "./policyForm";

/** Name and scope; a new policy starts with the default settings and no monitors of its own. */
export default function NewPolicyModal({
  names,
  onCreated,
  onClose,
}: {
  names: ScopeNames;
  onCreated: (policy: MonitoringPolicy) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [scope, setScope] = useState<PolicyScope>("device_type");
  const [scopeValue, setScopeValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const ready = name.trim().length > 0 && scopeValue !== "";

  const create = async () => {
    if (!ready) return;
    setBusy(true);
    setError(null);
    try {
      onCreated(await createMonitoringPolicy(blankBody(name, description, scope, scopeValue)));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't create the policy");
      setBusy(false);
    }
  };

  return (
    <Modal
      title="New monitoring policy"
      subtitle="It starts with the default collection settings and no monitors of its own."
      icon={Plus}
      busy={busy}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={() => void create()} disabled={!ready || busy}>
            {busy ? "Creating…" : "Create policy"}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {error && (
          <div
            className="th-onb-note"
            style={{ "--onb-tone": "var(--th-status-critical)" } as CSSProperties}
            role="alert"
          >
            <AlertTriangle className="h-4 w-4" />
            <span>{error}</span>
          </div>
        )}
        <label className="th-onb-field">
          Name
          <input
            value={name}
            maxLength={120}
            placeholder="e.g. SQL servers"
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <label className="th-onb-field">
          Description
          <input
            value={description}
            maxLength={2000}
            placeholder="What this policy is for (optional)"
            onChange={(e) => setDescription(e.target.value)}
          />
        </label>
        <ScopePicker
          scope={scope}
          value={scopeValue}
          names={names}
          onChange={(nextScope, nextValue) => {
            setScope(nextScope);
            setScopeValue(nextValue);
          }}
        />
      </div>
    </Modal>
  );
}
