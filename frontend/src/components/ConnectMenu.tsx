import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ChevronDown, CircleAlert, Link2, Monitor, Globe, Pin, PinOff, Plus } from "lucide-react";

import { fetchJson } from "../api/client";
import {
  type ConnectMethod, getConnectMethods, resetConnectPreference, setConnectPreference,
} from "../api/connect";
import { clickProtocolUrl } from "../services/rustdeskLaunch";
import { detectOperatorOS } from "../utils/operatorOs";

const EmbeddedSSHModal = lazy(() => import("./EmbeddedSSHModal"));

// Connect Framework UI (Platform Expansion Phase 7; credential-aware status +
// per-operator defaults added in the Credential Assignment + Connect
// Resolution release). The dropdown is built ENTIRELY from
// GET /devices/{id}/connect-methods — no hardcoded per-platform menus.
//
// Every method the platform declares is always shown (Section E: "Do not
// hide a method merely because credentials are missing") with one of three
// states, computed by merging the backend's credential-aware status with the
// operator-OS check (backend doesn't know the browser's OS):
//   - ready               — usable now (credential_source shown when a Vault
//                           credential resolved it: Device/Group/Client/Global)
//   - credential_required — exists for this platform, but no compatible Vault
//                           credential resolves yet; clicking offers "Add
//                           credential", prefilled with device/method/scope
//   - unavailable_os      — the method's desktop app doesn't exist on the
//                           OPERATOR's OS (e.g. Winbox.exe is Windows-only)
//
// Selecting a Ready method calls the generic launcher
// (`/connect-methods/{id}/launch`, scheme:// or http(s)://) except "ssh",
// whose default action is the Embedded SSH Connect terminal (the external OS
// SSH client stays a secondary link inside that modal). `remote_support`/
// `web_terminal` keep their own existing dedicated flows (Remote Support tab
// / Terminal tab) and are not launched from here.
//
// "Always use this method" (Section G) pins a per-operator+platform default
// (PUT /connect-preferences); the pinned method is highlighted, and defaults
// can be viewed/reset from Settings ▸ Connect Defaults.

type DisplayStatus = "ready" | "credential_required" | "unavailable_os";

interface Props {
  deviceId: number;
}

const DEDICATED_METHOD_IDS = new Set(["remote_support", "web_terminal"]);
const METHOD_CREDENTIAL_TYPE: Record<string, string> = { ssh: "ssh_password", winbox: "winbox", webfig: "webfig" };
const CREDENTIAL_SOURCE_LABEL: Record<string, string> = {
  device: "Device credential", group: "Group credential", client: "Client credential", global: "Global credential",
};

function displayStatus(m: ConnectMethod, operatorOS: string | null): DisplayStatus {
  if (m.requires_client_os && m.requires_client_os !== operatorOS) return "unavailable_os";
  return m.status;
}

export default function ConnectMenu({ deviceId }: Props) {
  const navigate = useNavigate();
  const [platform, setPlatform] = useState<string | null>(null);
  const [methods, setMethods] = useState<ConnectMethod[] | null>(null);
  const [preferredMethodId, setPreferredMethodId] = useState<string | null>(null);
  const [configuredPreferenceId, setConfiguredPreferenceId] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [launching, setLaunching] = useState<string | null>(null);
  const [sshModalOpen, setSshModalOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  const operatorOS = detectOperatorOS();

  const reload = () => {
    getConnectMethods(deviceId)
      .then((r) => {
        setPlatform(r.platform);
        setMethods(r.methods);
        setPreferredMethodId(r.preferred_method_id);
        setConfiguredPreferenceId(r.configured_preference_id);
      })
      .catch(() => setMethods([]));
  };

  useEffect(() => {
    let active = true;
    getConnectMethods(deviceId)
      .then((r) => {
        if (!active) return;
        setPlatform(r.platform);
        setMethods(r.methods);
        setPreferredMethodId(r.preferred_method_id);
        setConfiguredPreferenceId(r.configured_preference_id);
      })
      .catch(() => { if (active) setMethods([]); });
    return () => { active = false; };
  }, [deviceId]);

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  // No methods available at all (e.g. device reports no relevant
  // capability) → nothing to connect with; render nothing rather than an
  // empty menu. A method that merely needs a credential still counts as
  // "available" — it's shown with a Credential required state, not hidden.
  if (methods !== null && methods.length === 0) return null;

  const launchExternalSsh = async () => {
    try {
      const res = await fetchJson<{ url: string; surface: "desktop" | "browser" }>(
        `/api/v1/devices/${deviceId}/connect-methods/ssh/launch`,
      );
      clickProtocolUrl(res.url);
    } catch (e) {
      setNote(e instanceof Error ? e.message : "Could not launch the external SSH client");
    }
  };

  const goAddCredential = (m: ConnectMethod) => {
    setOpen(false);
    const credentialType = METHOD_CREDENTIAL_TYPE[m.id];
    const params = new URLSearchParams({
      prefill_scope: "device", prefill_device_id: String(deviceId),
      ...(credentialType ? { prefill_credential_type: credentialType } : {}),
      prefill_purpose: m.id === "webfig" ? "WebFig" : "",
    });
    navigate(`/vault?${params.toString()}`);
  };

  const launch = async (m: ConnectMethod) => {
    const status = displayStatus(m, operatorOS);
    if (status === "unavailable_os") return;
    if (status === "credential_required") {
      goAddCredential(m);
      return;
    }
    setOpen(false);
    if (DEDICATED_METHOD_IDS.has(m.id)) {
      setNote(`${m.label} has its own Connect flow (see the ${m.id === "remote_support" ? "Remote Support" : "Terminal"} tab).`);
      return;
    }
    // Embedded SSH Connect: default action for "ssh" is now the embedded
    // terminal, not the generic scheme://<ip> launcher. The external OS SSH
    // client remains one click away inside the modal.
    if (m.id === "ssh") {
      setSshModalOpen(true);
      return;
    }
    setLaunching(m.id);
    try {
      const res = await fetchJson<{ url: string; surface: "desktop" | "browser" }>(
        `/api/v1/devices/${deviceId}/connect-methods/${m.id}/launch`,
      );
      if (res.surface === "desktop") {
        clickProtocolUrl(res.url);
      } else {
        window.open(res.url, "_blank", "noopener,noreferrer");
      }
    } catch (e) {
      setNote(e instanceof Error ? e.message : `Could not launch ${m.label}`);
    } finally {
      setLaunching(null);
    }
  };

  const togglePreferred = async (e: React.MouseEvent, m: ConnectMethod) => {
    e.stopPropagation();
    if (!platform) return;
    try {
      if (configuredPreferenceId === m.id) {
        await resetConnectPreference(platform);
      } else {
        await setConnectPreference(platform, m.id);
      }
      reload();
    } catch (err) {
      setNote(err instanceof Error ? err.message : "Could not update the default Connect method");
    }
  };

  const reasonFor = (m: ConnectMethod, status: DisplayStatus): string | null => {
    if (status === "unavailable_os") return `Unavailable on ${operatorOS ?? "this operating system"}`;
    if (status === "credential_required") return m.status_reason ?? "No compatible credential configured";
    if (m.credential_source) return CREDENTIAL_SOURCE_LABEL[m.credential_source] ?? null;
    return null;
  };

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={methods === null}
        className="inline-flex items-center gap-1.5 rounded-lg px-3.5 py-2 text-[13px] font-semibold transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
        style={{ background: "var(--th-accent-dim-bg)", border: "1px solid var(--th-accent-border)", color: "var(--th-accent-bright)" }}
      >
        <Link2 className="h-3.5 w-3.5" />
        Connect
        <ChevronDown className={`h-3.5 w-3.5 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>

      {open && methods && (
        <div
          className="absolute right-0 z-50 mt-1.5 min-w-[260px] overflow-hidden rounded-lg shadow-2xl"
          style={{ background: "var(--th-bg-card)", border: "1px solid var(--th-border-card)" }}
        >
          {methods.map((m) => {
            const status = displayStatus(m, operatorOS);
            const reason = reasonFor(m, status);
            const isPreferred = preferredMethodId === m.id;
            const isConfigured = configuredPreferenceId === m.id;
            const disabled = launching === m.id || status === "unavailable_os";
            return (
              <button
                key={m.id}
                type="button"
                disabled={disabled}
                onClick={() => void launch(m)}
                title={status === "unavailable_os" ? reason ?? undefined : undefined}
                className="flex w-full items-center gap-2.5 px-3 py-2.5 text-left text-[13px] font-medium transition hover:bg-[var(--th-bg-card-hover)] disabled:cursor-not-allowed disabled:opacity-50"
                style={{ color: "var(--th-text-primary)" }}
              >
                {status === "credential_required"
                  ? <CircleAlert className="h-4 w-4 flex-none" style={{ color: "var(--th-status-warning, #f59e0b)" }} />
                  : m.surface === "browser"
                    ? <Globe className="h-4 w-4 flex-none" style={{ color: "var(--th-text-muted)" }} />
                    : <Monitor className="h-4 w-4 flex-none" style={{ color: "var(--th-text-muted)" }} />}
                <span className="flex flex-1 flex-col items-start">
                  <span className="flex items-center gap-1.5">
                    {launching === m.id ? "Opening…" : m.label}
                    {isPreferred && (
                      <span className="rounded-full px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide" style={{ background: "var(--th-accent-glow)", color: "var(--th-accent)" }}>
                        Default
                      </span>
                    )}
                  </span>
                  {reason && (
                    <span
                      className="text-[10.5px] font-normal"
                      style={{ color: status === "credential_required" ? "var(--th-status-warning, #f59e0b)" : "var(--th-text-faint)" }}
                    >
                      {status === "credential_required" ? `${reason} · Add credential` : reason}
                    </span>
                  )}
                </span>
                {status === "ready" && platform && (
                  <span
                    role="button"
                    tabIndex={0}
                    onClick={(e) => void togglePreferred(e, m)}
                    title={isConfigured ? "Stop always using this method" : "Always use this method"}
                    className="flex-none rounded p-1 hover:bg-[var(--th-bg-card-hover)]"
                  >
                    {isConfigured
                      ? <Pin className="h-3.5 w-3.5" style={{ color: "var(--th-accent)" }} />
                      : <PinOff className="h-3.5 w-3.5" style={{ color: "var(--th-text-faint)" }} />}
                  </span>
                )}
                {status === "credential_required" && <Plus className="h-3.5 w-3.5 flex-none" style={{ color: "var(--th-text-faint)" }} />}
              </button>
            );
          })}
        </div>
      )}

      {note && (
        <div className="absolute right-0 z-40 mt-1.5 min-w-[220px] cursor-pointer rounded-md px-3 py-2 text-xs leading-snug"
          style={{ background: "var(--th-bg-drawer-section)", border: "1px solid var(--th-border-drawer-section)", color: "var(--th-text-secondary)" }}
          onClick={() => setNote(null)}>
          {note}
        </div>
      )}

      {sshModalOpen && (
        <Suspense fallback={null}>
          <EmbeddedSSHModal
            deviceId={deviceId}
            onClose={() => setSshModalOpen(false)}
            onOpenExternal={() => void launchExternalSsh()}
          />
        </Suspense>
      )}
    </div>
  );
}
