import { lazy, Suspense, useEffect, useState } from "react";
import { AlertTriangle, ExternalLink, Terminal as TerminalIcon, X } from "lucide-react";

import { getSshCredentialCandidates, type SSHCredentialCandidate } from "../api/terminal";

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
        if (active) setStage({ kind: "error", message: e instanceof Error ? e.message : "Failed to resolve SSH credentials" });
      });
    return () => { active = false; };
  }, [deviceId]);

  const startTemporary = () => {
    if (!tempUsername || !tempPassword) return;
    setSessionId(null);
    setStage({ kind: "connecting", temporary: { username: tempUsername, password: tempPassword } });
  };

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center p-4"
      style={{ background: "rgba(0,0,0,0.6)" }}
      onClick={onClose}
    >
      <div
        className="flex max-h-[85vh] w-full max-w-3xl flex-col gap-3 rounded-xl p-4"
        style={{ background: "var(--th-bg-card)", border: "1px solid var(--th-border-card)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-sm font-semibold" style={{ color: "var(--th-text-primary)" }}>
            <TerminalIcon className="h-4 w-4" />
            Embedded SSH Connect
          </div>
          <button type="button" onClick={onClose} className="rounded p-1 hover:bg-[var(--th-bg-card-hover)]" aria-label="Close">
            <X className="h-4 w-4" style={{ color: "var(--th-text-secondary)" }} />
          </button>
        </div>

        {stage.kind === "loading" && (
          <div className="py-8 text-center text-sm" style={{ color: "var(--th-text-secondary)" }}>
            Resolving SSH credentials…
          </div>
        )}

        {stage.kind === "error" && (
          <div
            className="flex items-center gap-2 rounded-md px-3 py-2 text-sm"
            style={{ color: "#f87171", background: "var(--th-bg-drawer-section)" }}
          >
            <AlertTriangle className="h-4 w-4 flex-none" />
            {stage.message}
          </div>
        )}

        {stage.kind === "none" && (
          <div className="flex flex-col gap-3">
            <div
              className="flex items-start gap-2 rounded-md px-3 py-2 text-sm"
              style={{
                color: "var(--th-text-secondary)",
                background: "var(--th-bg-drawer-section)",
                border: "1px solid var(--th-border-drawer-section)",
              }}
            >
              <AlertTriangle className="mt-0.5 h-4 w-4 flex-none" />
              <span>
                No SSH credential is available for this device. Add one in the Credential Vault (Device, Group,
                Client, or Global scope), or start a Temporary Session below.
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
            <div className="text-xs" style={{ color: "var(--th-text-secondary)" }}>
              Multiple SSH credentials are available for this device — choose one:
            </div>
            {stage.candidates.map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => { setSessionId(null); setStage({ kind: "connecting", credentialId: c.id }); }}
                className="flex items-center justify-between rounded-md px-3 py-2 text-left text-sm transition hover:bg-[var(--th-bg-card-hover)]"
                style={{ border: "1px solid var(--th-border-drawer-section)", color: "var(--th-text-primary)" }}
              >
                <span>{c.name}</span>
                <span className="text-xs" style={{ color: "var(--th-text-faint)" }}>{c.username}</span>
              </button>
            ))}
            <button
              type="button"
              onClick={() => setStage({ kind: "temporary" })}
              className="self-start text-xs underline"
              style={{ color: "var(--th-text-faint)" }}
            >
              Use a Temporary Session instead
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
              <Suspense fallback={<div className="py-8 text-center text-sm">Loading terminal…</div>}>
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

        <div className="flex items-center justify-between border-t pt-2 text-xs" style={{ borderColor: "var(--th-border-drawer-section)" }}>
          <button
            type="button"
            onClick={onOpenExternal}
            className="inline-flex items-center gap-1 underline"
            style={{ color: "var(--th-text-faint)" }}
          >
            <ExternalLink className="h-3 w-3" />
            Open in your own SSH client instead
          </button>
        </div>
      </div>
    </div>
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
    <div className="flex flex-col gap-2 rounded-md p-3" style={{ border: "1px solid var(--th-border-drawer-section)" }}>
      <div className="text-xs font-semibold" style={{ color: "var(--th-text-primary)" }}>Temporary Session</div>
      <div className="text-[11px]" style={{ color: "var(--th-text-faint)" }}>
        Entered once, used only for this connection, never saved to the Credential Vault.
      </div>
      <input
        type="text"
        placeholder="Username"
        value={username}
        onChange={(e) => onUsername(e.target.value)}
        className="rounded-md px-2 py-1.5 text-sm outline-none"
        style={{ background: "var(--th-bg-input)", border: "1px solid var(--th-border-drawer-section)", color: "var(--th-text-primary)" }}
      />
      <input
        type="password"
        placeholder="Password"
        value={password}
        onChange={(e) => onPassword(e.target.value)}
        className="rounded-md px-2 py-1.5 text-sm outline-none"
        style={{ background: "var(--th-bg-input)", border: "1px solid var(--th-border-drawer-section)", color: "var(--th-text-primary)" }}
      />
      <button
        type="button"
        onClick={onSubmit}
        disabled={!username || !password}
        className="self-start rounded-md px-3 py-1.5 text-xs font-semibold disabled:cursor-not-allowed disabled:opacity-50"
        style={{ background: "var(--th-accent)", color: "#fff" }}
      >
        Connect
      </button>
    </div>
  );
}
