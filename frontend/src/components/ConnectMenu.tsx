import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ChevronDown, CircleAlert, Monitor, Globe, Pin, PinOff, Plus, Terminal, ExternalLink } from "lucide-react";

import { fetchJson } from "../api/client";
import {
  CONNECT_REFRESH_EVENT,
  type ConnectMethod, emitConnectRefresh, getConnectMethods, resetConnectPreference, setConnectPreference,
} from "../api/connect";
import { clickProtocolUrl } from "../services/rustdeskLaunch";
import { detectOperatorOS } from "../utils/operatorOs";

const EmbeddedSSHModal = lazy(() => import("./EmbeddedSSHModal"));

// Connect Framework UI, aligned with the approved V3 Connect mockup:
//
// - SPLIT BUTTON: the main "Connect" segment launches the operator's SAVED
//   default method immediately when it's Ready; with no saved preference it
//   opens the menu once so the operator chooses (and can tick "Always use
//   this option"). The ▾ arrow segment always opens the method menu directly.
//   Neither segment ever opens the Device Drawer.
// - CATEGORIZED MENU, built ENTIRELY from GET /devices/{id}/connect-methods:
//   Recommended (the effective default) · Available (embedded methods) ·
//   Web · Desktop Applications · Unavailable. Every method the platform
//   declares is ALWAYS shown; a method that can't run right now is disabled
//   with its reason (Winbox on macOS/Linux: "Windows only · Unavailable on
//   …"; embedded methods outside the FEATURE_TERMINAL rollout: the backend's
//   honest reason) — never hidden.
// - Each row: icon · method name · transport/source label · status ·
//   credential source (Vault scope tier) · unavailable reason.
// - "Always use this option" (menu footer) saves the launched method as the
//   per-operator platform default; the per-row pin does the same per method.
//   Defaults are viewed/reset from Settings ▸ Connect Defaults.
// - Launch targets: "ssh" → Embedded SSH terminal (external OS SSH client
//   stays a secondary link inside that modal); "web_terminal" → the Embedded
//   Terminal (onOpenTerminal callback — Drawer Terminal tab);
//   "remote_support" → onRemoteSupport callback (the existing RustDesk
//   flow / Remote Support tab); everything else → the generic audited
//   launcher (`/connect-methods/{id}/launch`).
// - Listens for CONNECT_REFRESH_EVENT so credential/preference changes are
//   reflected immediately, with no manual refresh.

type DisplayStatus = "ready" | "credential_required" | "unavailable_os" | "unavailable";

interface Props {
  deviceId: number;
  // Menu header: "Connect to <hostname>" (approved mockup).
  hostname?: string;
  // "drawer" (default): full-size trigger used inside the Device Drawer.
  // "row": compact trigger for a Device Catalog row; the menu is positioned
  // fixed (the table's scroll container would clip an absolute dropdown).
  variant?: "drawer" | "row";
  // Row variant: don't fetch on mount (a 100-row table would N+1); fetch on
  // first interaction instead. The row's button state comes from the batch
  // /connect-status feed via initialState until then.
  lazyLoad?: boolean;
  initialState?: "ready" | "credential_required" | "unavailable" | null;
  initialStateReason?: string | null;
  onOpenTerminal?: () => void;
  onRemoteSupport?: () => void;
}

const DEDICATED_METHOD_IDS = new Set(["remote_support", "web_terminal"]);
const METHOD_CREDENTIAL_TYPE: Record<string, string> = { ssh: "ssh_password", winbox: "winbox", webfig: "webfig" };
const CREDENTIAL_SOURCE_LABEL: Record<string, string> = {
  device: "Device credential", group: "Group credential", client: "Client credential", global: "Global credential",
};
const OS_LABEL: Record<string, string> = { windows: "Windows", macos: "macOS", linux: "Linux" };

export function displayStatus(m: ConnectMethod, operatorOS: string | null): DisplayStatus {
  if (m.requires_client_os && m.requires_client_os !== operatorOS) return "unavailable_os";
  return m.status;
}

export interface ConnectMethodGroup {
  label: string;
  methods: ConnectMethod[];
}

// Approved mockup menu structure. Static kind comes from the registry
// (category); Recommended and Unavailable are derived per-device/operator:
// the effective default (when usable) leads, feature-gated methods sink to
// Unavailable, and an OS-mismatched desktop app STAYS under Desktop
// Applications — visible, disabled, with its reason.
export function groupConnectMethods(
  methods: ConnectMethod[],
  preferredMethodId: string | null,
  operatorOS: string | null,
): ConnectMethodGroup[] {
  const groups: Record<string, ConnectMethod[]> = {
    Recommended: [], Available: [], Web: [], "Desktop Applications": [], Unavailable: [],
  };
  for (const m of methods) {
    const status = displayStatus(m, operatorOS);
    if (m.id === preferredMethodId && status === "ready") {
      groups.Recommended.push(m);
    } else if (status === "unavailable") {
      groups.Unavailable.push(m);
    } else if (m.category === "web") {
      groups.Web.push(m);
    } else if (m.category === "desktop_app") {
      groups["Desktop Applications"].push(m);
    } else {
      groups.Available.push(m);
    }
  }
  return Object.entries(groups)
    .filter(([, items]) => items.length > 0)
    .map(([label, items]) => ({ label, methods: items.sort((a, b) => a.priority - b.priority) }));
}

export default function ConnectMenu({
  deviceId, hostname, variant = "drawer", lazyLoad = false,
  initialState = null, initialStateReason = null, onOpenTerminal, onRemoteSupport,
}: Props) {
  const navigate = useNavigate();
  const [platform, setPlatform] = useState<string | null>(null);
  const [methods, setMethods] = useState<ConnectMethod[] | null>(null);
  const [preferredMethodId, setPreferredMethodId] = useState<string | null>(null);
  const [configuredPreferenceId, setConfiguredPreferenceId] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [launching, setLaunching] = useState<string | null>(null);
  const [alwaysUse, setAlwaysUse] = useState(false);
  const [sshModalOpen, setSshModalOpen] = useState(false);
  const [menuPos, setMenuPos] = useState<{ top: number; right: number } | null>(null);
  const ref = useRef<HTMLDivElement | null>(null);
  const operatorOS = detectOperatorOS();

  interface LoadedData {
    methods: ConnectMethod[];
    configured: string | null;
  }
  const loadPromise = useRef<Promise<LoadedData | null> | null>(null);

  // Returns the fetched data directly (not via state) — a lazy row's first
  // main-click must decide "launch default vs open menu" from THIS response,
  // not from state that React hasn't committed yet.
  const load = (): Promise<LoadedData | null> => {
    const p = getConnectMethods(deviceId, operatorOS)
      .then((r) => {
        const list = Array.isArray(r?.methods) ? r.methods : [];
        setPlatform(r?.platform ?? null);
        setMethods(list);
        setPreferredMethodId(r?.preferred_method_id ?? null);
        setConfiguredPreferenceId(r?.configured_preference_id ?? null);
        return { methods: list, configured: r?.configured_preference_id ?? null };
      })
      .catch(() => {
        setMethods([]);
        return null;
      });
    loadPromise.current = p;
    return p;
  };

  useEffect(() => {
    loadPromise.current = null;
    setMethods(null);
    if (!lazyLoad) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deviceId]);

  // Credential added / default pinned / reset anywhere in the app → refresh
  // immediately (approved behavior: no manual refresh needed). Only reload
  // if this instance has fetched at least once — an untouched lazy row stays
  // lazy.
  useEffect(() => {
    const onRefresh = () => { if (loadPromise.current) void load(); };
    window.addEventListener(CONNECT_REFRESH_EVENT, onRefresh);
    return () => window.removeEventListener(CONNECT_REFRESH_EVENT, onRefresh);
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
  // empty menu (drawer variant only — a lazy row hasn't fetched yet).
  if (!lazyLoad && methods !== null && methods.length === 0) return null;

  const ensureLoaded = async (): Promise<LoadedData | null> => {
    if (methods !== null) return { methods, configured: configuredPreferenceId };
    if (loadPromise.current) return loadPromise.current;
    return load();
  };

  // In the row variant both the menu and the note render `position: fixed`, so
  // they need explicit coordinates. Measuring only in openMenu() was a bug: a
  // main-click launch of a Ready default never opens the menu, so menuPos was
  // still null and the note fell back to its static position — directly on top
  // of the Connect button it was meant to sit under.
  const anchorBelowButton = () => {
    if (variant !== "row" || !ref.current) return;
    const rect = ref.current.getBoundingClientRect();
    setMenuPos({ top: rect.bottom + 6, right: Math.max(8, window.innerWidth - rect.right) });
  };

  const showNote = (text: string) => {
    anchorBelowButton();
    setNote(text);
  };

  const openMenu = () => {
    anchorBelowButton();
    setOpen(true);
  };

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

  const persistAlwaysUse = async (m: ConnectMethod) => {
    if (!alwaysUse || !platform) return;
    try {
      await setConnectPreference(platform, m.id);
      setAlwaysUse(false);
      emitConnectRefresh();
    } catch {
      setNote("Could not save the default Connect method");
    }
  };

  const launch = async (m: ConnectMethod) => {
    const status = displayStatus(m, operatorOS);
    if (status === "unavailable_os" || status === "unavailable") return;
    if (status === "credential_required") {
      goAddCredential(m);
      return;
    }
    void persistAlwaysUse(m);
    setOpen(false);
    if (m.id === "web_terminal") {
      if (onOpenTerminal) onOpenTerminal();
      else setNote("Embedded Terminal opens from the device's Terminal tab.");
      return;
    }
    if (m.id === "remote_support") {
      if (onRemoteSupport) onRemoteSupport();
      else setNote("TECHI Remote Support has its own Connect flow (see the Remote Support tab).");
      return;
    }
    // Embedded SSH Connect: default action for "ssh" is the embedded
    // terminal, not the generic scheme://<ip> launcher. The external OS SSH
    // client remains one click away inside the modal.
    if (m.id === "ssh") {
      setSshModalOpen(true);
      return;
    }
    setLaunching(m.id);
    try {
      const res = await fetchJson<{ url: string; surface: "desktop" | "browser"; insecure?: boolean }>(
        `/api/v1/devices/${deviceId}/connect-methods/${m.id}/launch`,
      );
      if (res.surface === "desktop" && m.id === "winbox" && operatorOS === "macos") {
        // WinBox.app for macOS ships NO CFBundleURLTypes — verified against
        // 4.3.102000 (com.mikrotik.winbox) — so it registers no scheme and a
        // winbox:// link is a dead click there, unlike Windows where Winbox 4
        // does register the handler. macOS operators open the app themselves,
        // so hand them the address rather than pretending to launch it.
        const address = res.url.replace(/^winbox:\/\//, "");
        try {
          await navigator.clipboard.writeText(address);
          showNote(`Winbox has no macOS URL handler. Address copied — paste ${address} into WinBox.`);
        } catch {
          showNote(`Winbox has no macOS URL handler. Open WinBox and connect to ${address}.`);
        }
      } else if (res.surface === "desktop") {
        clickProtocolUrl(res.url);
        if (m.id === "winbox") {
          // The browser cannot detect whether the handler exists, so this
          // cannot claim success — but it must not read as an error either: it
          // fires on every launch, including the ones that worked. State the
          // handoff, then the remedy.
          showNote("Opening Winbox… If nothing happened, install Winbox 4 — it registers the winbox:// handler.");
        }
      } else {
        window.open(res.url, "_blank", "noopener,noreferrer");
        if (res.insecure) {
          // Plain http: whatever is typed into that page — the router password
          // included — crosses the network unencrypted. Say so rather than let
          // it look like any other connection. Fixed by enabling www-ssl on the
          // device and setting its Connect port to 443.
          showNote(`${m.label} opened over plain HTTP — the password you type is sent unencrypted. Enable www-ssl on the device and set its Connect port to 443.`);
        }
      }
    } catch (e) {
      showNote(e instanceof Error ? e.message : `Could not launch ${m.label}`);
    } finally {
      setLaunching(null);
    }
  };

  // Main segment (approved behavior): saved default that's Ready → launch it
  // immediately; anything else → open the menu once so the operator chooses.
  const onMainClick = async () => {
    if (open) { setOpen(false); return; }
    const loaded = await ensureLoaded();
    const configured = loaded?.methods.find((m) => m.id === loaded.configured);
    if (configured && displayStatus(configured, operatorOS) === "ready") {
      void launch(configured);
      return;
    }
    openMenu();
  };

  const onArrowClick = async () => {
    if (open) { setOpen(false); return; }
    await ensureLoaded();
    openMenu();
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
      emitConnectRefresh();
    } catch (err) {
      setNote(err instanceof Error ? err.message : "Could not update the default Connect method");
    }
  };

  // Second line of each row: transport/source · status · reason.
  const subLabel = (m: ConnectMethod, status: DisplayStatus): string | null => {
    if (status === "unavailable_os") {
      const requiredOs = OS_LABEL[m.requires_client_os ?? ""] ?? m.requires_client_os;
      const currentOs = OS_LABEL[operatorOS ?? ""] ?? "this operating system";
      return `${requiredOs} only · Unavailable on ${currentOs}`;
    }
    if (status === "unavailable") return m.status_reason ?? "Unavailable";
    if (status === "credential_required") {
      return `${m.transport || "Method"} · Credential required · Add credential`;
    }
    const source = m.credential_source ? CREDENTIAL_SOURCE_LABEL[m.credential_source] : m.transport;
    return source ? `${source} · Ready` : "Ready";
  };

  const rowState = initialState;
  const isRow = variant === "row";
  const connectTone = rowState === "credential_required" ? "warning" : rowState === "unavailable" ? "muted" : "default";

  const mainTitle = rowState === "credential_required"
    ? (initialStateReason ?? "Credential required — open the menu to add one")
    : rowState === "unavailable"
      ? (initialStateReason ?? "No Connect method available for this device yet")
      : undefined;

  const menuBody = methods && (
    <div
      className={`${isRow ? "fixed" : "absolute right-0 mt-1.5"} z-50 min-w-[280px] overflow-hidden rounded-lg shadow-2xl`}
      style={{
        background: "var(--th-bg-card)", border: "1px solid var(--th-border-card)",
        ...(isRow && menuPos ? { top: menuPos.top, right: menuPos.right } : {}),
      }}
    >
      {hostname && (
        <div className="px-3 pb-1 pt-2.5 font-mono text-[11px] font-bold uppercase tracking-widest" style={{ color: "var(--th-text-faint)" }}>
          Connect to {hostname}
        </div>
      )}
      {methods.length === 0 && (
        <div className="px-3 py-2.5 text-[12px]" style={{ color: "var(--th-text-muted)" }}>
          No Connect method available for this device yet.
        </div>
      )}
      {groupConnectMethods(methods, preferredMethodId, operatorOS).map((group) => (
        <div key={group.label}>
          <div className="px-3 pb-0.5 pt-2 font-mono text-[11px] font-bold uppercase tracking-widest" style={{ color: "var(--th-text-faint)" }}>
            {group.label}
          </div>
          {group.methods.map((m) => {
            const status = displayStatus(m, operatorOS);
            const reason = subLabel(m, status);
            const isPreferred = preferredMethodId === m.id;
            const isConfigured = configuredPreferenceId === m.id;
            const disabled = launching === m.id || status === "unavailable_os" || status === "unavailable";
            return (
              <button
                key={m.id}
                type="button"
                disabled={disabled}
                onClick={() => void launch(m)}
                title={status === "unavailable_os" || status === "unavailable" ? reason ?? undefined : undefined}
                className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-[13px] font-medium transition hover:bg-[var(--th-bg-card-hover)] disabled:cursor-not-allowed disabled:opacity-50"
                style={{ color: "var(--th-text-primary)" }}
              >
                {status === "credential_required"
                  ? <CircleAlert className="h-4 w-4 flex-none" style={{ color: "var(--th-status-warning, var(--th-status-warning))" }} />
                  : m.embedded
                    ? <Terminal className="h-4 w-4 flex-none" style={{ color: "var(--th-text-muted)" }} />
                    : m.surface === "browser"
                      ? <Globe className="h-4 w-4 flex-none" style={{ color: "var(--th-text-muted)" }} />
                      : <Monitor className="h-4 w-4 flex-none" style={{ color: "var(--th-text-muted)" }} />}
                <span className="flex flex-1 flex-col items-start">
                  <span className="flex items-center gap-1.5">
                    {launching === m.id ? "Opening…" : m.label}
                    {isPreferred && (
                      <span className="rounded-full px-1.5 py-0.5 text-[11px] font-bold uppercase tracking-wide" style={{ background: "var(--th-accent-glow)", color: "var(--th-accent)" }}>
                        Default
                      </span>
                    )}
                  </span>
                  {reason && (
                    <span
                      className="text-[11px] font-normal"
                      style={{ color: status === "credential_required" ? "var(--th-status-warning, var(--th-status-warning))" : "var(--th-text-faint)" }}
                    >
                      {reason}
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
      ))}
      {methods.length > 0 && (
        <label
          className="flex cursor-pointer items-center gap-2 px-3 py-2 text-[11px]"
          style={{ borderTop: "1px solid var(--th-border-subtle)", color: "var(--th-text-secondary)" }}
          onClick={(e) => e.stopPropagation()}
        >
          <input
            type="checkbox"
            checked={alwaysUse}
            onChange={(e) => setAlwaysUse(e.target.checked)}
            className="h-3 w-3 accent-orange-500"
          />
          Always use this option
        </label>
      )}
    </div>
  );

  return (
    <div className={`relative ${isRow ? "inline-flex" : ""}`} ref={ref}>
      <div className="th-connect-group">
        <button
          type="button"
          onClick={() => void onMainClick()}
          title={mainTitle}
          className="th-connect"
          data-size={isRow ? "sm" : "md"}
          data-tone={connectTone}
        >
          <ExternalLink className="th-connect-icon" />
          Connect
        </button>
        <button
          type="button"
          aria-label="Connect options"
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={() => void onArrowClick()}
          className="th-connect th-connect-arrow"
          data-size={isRow ? "sm" : "md"}
          data-tone={connectTone}
        >
          <ChevronDown className={`h-3.5 w-3.5 transition-transform ${open ? "rotate-180" : ""}`} />
        </button>
      </div>

      {open && menuBody}

      {note && (
        <div className={`${isRow ? "fixed" : "absolute right-0 mt-1.5"} z-40 min-w-[220px] max-w-[320px] cursor-pointer rounded-md px-3 py-2 text-xs leading-snug shadow-lg`}
          style={{
            // --th-bg-drawer-section is a ~2% tint meant to sit inside an
            // already-opaque panel. As a floating overlay it let whatever was
            // underneath read straight through the text, so this uses the same
            // opaque card background the dropdown itself uses.
            background: "var(--th-bg-card)", border: "1px solid var(--th-border-card)", color: "var(--th-text-secondary)",
            ...(isRow && menuPos ? { top: menuPos.top, right: menuPos.right } : {}),
          }}
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
