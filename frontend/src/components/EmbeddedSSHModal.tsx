import { lazy, Suspense, useEffect, useState } from "react";
import type { CSSProperties } from "react";
import { AlertTriangle, ExternalLink, Terminal as TerminalIcon } from "lucide-react";

import { getSshCredentialCandidates, type SSHCredentialCandidate } from "../api/terminal";
import Button from "./ui/Button";
import Modal from "./ui/Modal";

const DeviceTerminal = lazy(() => import("./DeviceTerminal"));
const SSHSessionInfo = lazy(() => import("./SSHSessionInfo"));

// Device Drawer: Connect -> SSH -> Embedded TECHI Terminal. Resolves
// Credential Vault candidates first (GET /devices/{id}/ssh/credentials):
// zero candidates shows a clear "no credential available" message + an
// explicit Temporary Session option; exactly one auto-connects; more than
// one shows a selector. Never falls back to asking for a password unless
// the operator explicitly picks Temporary Session. "Open in your own SSH
// client" stays available as the secondary/external option (ConnectMenu's
// existing generic launcher).

interface Props {
  deviceId: number;
  onClose: () => void;
  onOpenExternal: () => void;
}

type Stage =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "none" }
  | { kind: "select"; candidates: SSHCredentialCandidate[] }
  | { kind: "temporary" }
  | { kind: "connecting"; credentialId?: number; temporary?: { username: string; password: string } };

export default function EmbeddedSSHModal({ deviceId, onClose, onOpenExternal }: Props) {
  const [stage, setStage] = useState<Stage>({ kind: "loading" });
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [tempUsername, setTempUsername] = useState("");
  const [tempPassword, setTempPassword] = useState("");

  useEffect(() => {
    let active = true;
    getSshCredentialCandidates(deviceId)
      .then((res) => {
        if (!active) return;
        if (res.candidates.length === 0) setStage({ kind: "none" });
        else if (res.candidates.length === 1) setStage({ kind: "connecting", credentialId: res.candidates[0].id });
        else setStage({ kind: "select", candidates: res.candidates });
      })
      .catch((e) => {
        if (active)
          setStage({ kind: "error", message: e instanceof Error ? e.message : "Failed to resolve SSH credentials" });
      });
    return () => {
      active = false;
    };
  }, [deviceId]);

  const startTemporary = () => {
    if (!tempUsername || !tempPassword) return;
    setSessionId(null);
    setStage({ kind: "connecting", temporary: { username: tempUsername, password: tempPassword } });
  };

  return (
    <Modal
      title="Embedded SSH"
      subtitle="Uses a Credential Vault credential, or a temporary one you type in"
      icon={TerminalIcon}
      size="xl"
      onClose={onClose}
      footer={
        <button type="button" onClick={onOpenExternal} className="th-onb-link mr-auto">
          <ExternalLink className="h-3.5 w-3.5" />
          Open in your own SSH client instead
        </button>
      }
    >
      {stage.kind === "loading" && <div className="th-onb-empty">Resolving SSH credentials…</div>}

      {stage.kind === "error" && (
        <div
          className="th-onb-note"
          style={{ "--onb-tone": "var(--th-status-critical)" } as CSSProperties}
          role="alert"
        >
          <AlertTriangle className="h-4 w-4" />
          <span>{stage.message}</span>
        </div>
      )}

      {stage.kind === "none" && (
        <div className="flex flex-col gap-3">
          <div className="th-onb-note" style={{ "--onb-tone": "var(--th-status-warning)" } as CSSProperties}>
            <AlertTriangle className="h-4 w-4" />
            <span>
              No SSH credential is available for this device. Add one in the Credential Vault (Device, Group, Client, or
              Global scope), or start a Temporary Session below.
            </span>
          </div>
          <TemporaryForm
            username={tempUsername}
            password={tempPassword}
            onUsername={setTempUsername}
            onPassword={setTempPassword}
            onSubmit={startTemporary}
          />
        </div>
      )}

      {stage.kind === "select" && (
        <div className="flex flex-col gap-2">
          <span className="th-onb-hint">Several SSH credentials reach this device. Choose one:</span>
          {stage.candidates.map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => {
                setSessionId(null);
                setStage({ kind: "connecting", credentialId: c.id });
              }}
              className="th-onb-option flex items-center justify-between"
            >
              <span className="text-[13px] font-medium" style={{ color: "var(--th-text-primary)" }}>
                {c.name}
              </span>
              <span className="font-mono text-[12px]" style={{ color: "var(--th-text-muted)" }}>
                {c.username}
              </span>
            </button>
          ))}
          <button type="button" onClick={() => setStage({ kind: "temporary" })} className="th-onb-link self-start">
            Use a temporary session instead
          </button>
        </div>
      )}

      {stage.kind === "temporary" && (
        <TemporaryForm
          username={tempUsername}
          password={tempPassword}
          onUsername={setTempUsername}
          onPassword={setTempPassword}
          onSubmit={startTemporary}
        />
      )}

      {stage.kind === "connecting" && (
        <div className="flex min-h-[420px] flex-1 flex-col gap-2">
          {sessionId && (
            <Suspense fallback={null}>
              <SSHSessionInfo deviceId={deviceId} sessionId={sessionId} />
            </Suspense>
          )}
          <div className="flex-1">
            <Suspense fallback={<div className="th-onb-empty">Loading terminal…</div>}>
              <DeviceTerminal
                deviceId={deviceId}
                mode="ssh"
                sshOptions={{
                  credentialId: stage.credentialId,
                  temporaryUsername: stage.temporary?.username,
                  temporaryPassword: stage.temporary?.password,
                }}
                onSessionId={setSessionId}
              />
            </Suspense>
          </div>
        </div>
      )}
    </Modal>
  );
}

function TemporaryForm({
  username,
  password,
  onUsername,
  onPassword,
  onSubmit,
}: {
  username: string;
  password: string;
  onUsername: (v: string) => void;
  onPassword: (v: string) => void;
  onSubmit: () => void;
}) {
  return (
    <div className="th-onb-sub">
      <div>
        <div className="text-[13px] font-medium" style={{ color: "var(--th-text-primary)" }}>
          Temporary session
        </div>
        <div className="th-onb-hint">Used for this connection only and never saved to the Credential Vault.</div>
      </div>
      <div className="grid gap-3 sm:grid-cols-[1fr_1fr_auto]">
        <input
          type="text"
          placeholder="Username"
          value={username}
          onChange={(e) => onUsername(e.target.value)}
          aria-label="Username"
          data-autofocus
        />
        <input
          type="password"
          placeholder="Password"
          value={password}
          onChange={(e) => onPassword(e.target.value)}
          aria-label="Password"
          onKeyDown={(e) => e.key === "Enter" && onSubmit()}
        />
        <Button type="button" onClick={onSubmit} disabled={!username || !password}>
          Connect
        </Button>
      </div>
    </div>
  );
}
