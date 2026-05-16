import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, Check, Clipboard, RefreshCcw, Terminal } from "lucide-react";
import {
  EnrollmentBootstrapMode,
  EnrollmentBootstrapPlatform,
  EnrollmentBootstrapResponse,
  EnrollmentToken,
  generateEnrollmentBootstrap,
  getEnrollmentTokens,
} from "../api/enrollmentBootstrap";
import { API_BASE_URL } from "../api/client";
import { Button } from "../components/ui";

const defaultBackendUrl = API_BASE_URL;

export default function EnrollmentBootstrap() {
  const [tokens, setTokens] = useState<EnrollmentToken[]>([]);
  const [mode, setMode] = useState<EnrollmentBootstrapMode>("token");
  const [tokenId, setTokenId] = useState("");
  const [plaintextToken, setPlaintextToken] = useState("");
  const [backendUrl, setBackendUrl] = useState(defaultBackendUrl);
  const [platform, setPlatform] = useState<EnrollmentBootstrapPlatform>("windows");
  const [rustdeskEnabled, setRustdeskEnabled] = useState(false);
  const [rustdeskMsiUrl, setRustdeskMsiUrl] = useState("");
  const [rustdeskRendezvous, setRustdeskRendezvous] = useState("");
  const [rustdeskRelay, setRustdeskRelay] = useState("");
  const [rustdeskApi, setRustdeskApi] = useState("");
  const [rustdeskKey, setRustdeskKey] = useState("");
  const [rustdeskPassword, setRustdeskPassword] = useState("");
  const [bootstrap, setBootstrap] = useState<EnrollmentBootstrapResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [tokensLoading, setTokensLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  const activeTokens = useMemo(() => tokens.filter((token) => token.status === "active"), [tokens]);
  const selectedToken = useMemo(
    () => activeTokens.find((token) => String(token.id) === tokenId) ?? null,
    [activeTokens, tokenId]
  );

  const loadTokens = async () => {
    try {
      setTokensLoading(true);
      setError(null);
      const data = await getEnrollmentTokens();
      setTokens(data);
      const firstActive = data.find((token) => token.status === "active");
      if (!tokenId && firstActive) {
        setTokenId(String(firstActive.id));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load enrollment tokens");
    } finally {
      setTokensLoading(false);
    }
  };

  useEffect(() => {
    void loadTokens();
  }, []);

  const handleGenerate = async () => {
    if (mode === "token" && !tokenId) {
      setError("Select an active enrollment token");
      return;
    }

    try {
      setLoading(true);
      setError(null);
      const result = await generateEnrollmentBootstrap({
        mode,
        enrollment_token_id: mode === "token" ? Number(tokenId) : undefined,
        backend_url: backendUrl,
        platform,
        enrollment_token: mode === "token" && plaintextToken.trim() ? plaintextToken.trim() : undefined,
        rustdesk_manage_enabled: rustdeskEnabled,
        rustdesk_msi_url: rustdeskMsiUrl,
        rustdesk_rendezvous_server: rustdeskRendezvous,
        rustdesk_relay_server: rustdeskRelay,
        rustdesk_api_server: rustdeskApi,
        rustdesk_key: rustdeskKey,
        rustdesk_default_password: rustdeskPassword,
      });
      setBootstrap(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to generate bootstrap");
    } finally {
      setLoading(false);
    }
  };

  const copyText = async (key: string, value: string) => {
    await navigator.clipboard.writeText(value);
    setCopied(key);
    window.setTimeout(() => setCopied(null), 1600);
  };

  const canGenerate = mode === "gpo" || (mode === "token" && activeTokens.length > 0);

  return (
    <section className="premium-page space-y-5">
      <div className="premium-card overflow-hidden p-5 md:p-6">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <p className="premium-kicker">Enrollment</p>
            <h1 className="mt-2 text-2xl font-semibold text-white">Enrollment Bootstrap</h1>
            <p className="mt-2 max-w-2xl text-sm font-medium leading-6 text-slate-300">
              Generate onboarding commands and config templates for first-run agent enrollment.
            </p>
          </div>
          <Button size="sm" type="button" onClick={() => void loadTokens()} disabled={tokensLoading}>
            <RefreshCcw className="mr-2 h-4 w-4" />
            Refresh Tokens
          </Button>
        </div>
      </div>

      <div className="grid gap-5 xl:grid-cols-[380px_minmax(0,1fr)]">
        <div className="premium-card-soft p-5">
          <div className="mb-4 flex items-center gap-2">
            <Terminal className="h-4 w-4 text-techi-orange" />
            <h2 className="text-base font-semibold text-white">Generator</h2>
          </div>

          <div className="space-y-4">
            {/* Deployment mode */}
            <div>
              <span className="mb-1.5 block text-xs font-semibold text-slate-200">Deployment mode</span>
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => setMode("token")}
                  className={`rounded-lg border px-3 py-2 text-xs font-semibold transition ${
                    mode === "token"
                      ? "border-techi-orange/60 bg-techi-orange/10 text-techi-orange"
                      : "border-white/10 bg-slate-950 text-slate-300 hover:border-white/20"
                  }`}
                >
                  Token Enrollment
                </button>
                <button
                  type="button"
                  onClick={() => setMode("gpo")}
                  className={`rounded-lg border px-3 py-2 text-xs font-semibold transition ${
                    mode === "gpo"
                      ? "border-techi-orange/60 bg-techi-orange/10 text-techi-orange"
                      : "border-white/10 bg-slate-950 text-slate-300 hover:border-white/20"
                  }`}
                >
                  Trusted Domain / GPO
                </button>
              </div>
            </div>

            {/* GPO warning */}
            {mode === "gpo" && (
              <div className="flex gap-2 rounded-lg border border-amber-300/20 bg-amber-300/10 p-3 text-xs font-medium text-amber-100">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span>
                  Trusted domain deployment requires <strong>TRUSTED_DOMAIN_AUTO_ENROLLMENT=true</strong> on the backend.
                  Domain-joined machines enroll without a token.
                </span>
              </div>
            )}

            {/* Token fields (token mode only) */}
            {mode === "token" && (
              <>
                <label className="block">
                  <span className="mb-1.5 block text-xs font-semibold text-slate-200">Enrollment token</span>
                  <select
                    value={tokenId}
                    onChange={(event) => setTokenId(event.target.value)}
                    className="w-full rounded-lg border border-white/10 bg-slate-950 px-3 py-2.5 text-sm font-medium text-white outline-none transition focus:border-techi-orange/60"
                  >
                    {activeTokens.length === 0 && <option value="">No active tokens</option>}
                    {activeTokens.map((token) => (
                      <option key={token.id} value={token.id}>
                        #{token.id} - {token.name} ({token.use_count}/{token.max_uses})
                      </option>
                    ))}
                  </select>
                </label>

                <label className="block">
                  <span className="mb-1.5 block text-xs font-semibold text-slate-200">Plaintext token value</span>
                  <input
                    value={plaintextToken}
                    onChange={(event) => setPlaintextToken(event.target.value)}
                    placeholder="Paste once-created token, or leave blank for placeholder"
                    className="w-full rounded-lg border border-white/10 bg-slate-950 px-3 py-2.5 text-sm font-medium text-white placeholder:text-slate-500 outline-none transition focus:border-techi-orange/60"
                  />
                </label>
              </>
            )}

            <label className="block">
              <span className="mb-1.5 block text-xs font-semibold text-slate-200">Backend URL</span>
              <input
                value={backendUrl}
                onChange={(event) => setBackendUrl(event.target.value)}
                className="w-full rounded-lg border border-white/10 bg-slate-950 px-3 py-2.5 text-sm font-medium text-white outline-none transition focus:border-techi-orange/60"
              />
            </label>

            <label className="block">
              <span className="mb-1.5 block text-xs font-semibold text-slate-200">Platform</span>
              <select
                value={platform}
                onChange={(event) => setPlatform(event.target.value as EnrollmentBootstrapPlatform)}
                className="w-full rounded-lg border border-white/10 bg-slate-950 px-3 py-2.5 text-sm font-medium text-white outline-none transition focus:border-techi-orange/60"
              >
                <option value="windows">Windows</option>
                <option value="macos">macOS</option>
                <option value="linux">Linux</option>
              </select>
            </label>

            {/* RustDesk self-healing */}
            <div>
              <label className="flex cursor-pointer items-center gap-2">
                <input
                  type="checkbox"
                  checked={rustdeskEnabled}
                  onChange={(e) => setRustdeskEnabled(e.target.checked)}
                  className="h-4 w-4 rounded accent-techi-orange"
                />
                <span className="text-xs font-semibold text-slate-200">RustDesk self-healing (Windows)</span>
              </label>

              {rustdeskEnabled && (
                <div className="mt-3 space-y-3 rounded-lg border border-white/10 bg-slate-950/50 p-3">
                  {[
                    { label: "MSI URL", value: rustdeskMsiUrl, set: setRustdeskMsiUrl, placeholder: "http://server:8081/rustdesk.msi" },
                    { label: "Rendezvous server", value: rustdeskRendezvous, set: setRustdeskRendezvous, placeholder: "server IP or hostname" },
                    { label: "Relay server", value: rustdeskRelay, set: setRustdeskRelay, placeholder: "relay IP or hostname" },
                    { label: "API server", value: rustdeskApi, set: setRustdeskApi, placeholder: "http://server:21114" },
                    { label: "Public key", value: rustdeskKey, set: setRustdeskKey, placeholder: "base64 key" },
                    { label: "Default password", value: rustdeskPassword, set: setRustdeskPassword, placeholder: "initial RustDesk password" },
                  ].map(({ label, value, set, placeholder }) => (
                    <label key={label} className="block">
                      <span className="mb-1 block text-xs text-slate-400">{label}</span>
                      <input
                        value={value}
                        onChange={(e) => set(e.target.value)}
                        placeholder={placeholder}
                        className="w-full rounded-md border border-white/10 bg-slate-900 px-2.5 py-2 text-xs font-medium text-white placeholder:text-slate-500 outline-none transition focus:border-techi-orange/60"
                      />
                    </label>
                  ))}
                </div>
              )}
            </div>

            {error && (
              <div className="flex gap-2 rounded-lg border border-red-400/20 bg-red-500/10 p-3 text-sm font-medium text-red-100">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                <span>{error}</span>
              </div>
            )}

            <Button className="w-full" type="button" onClick={handleGenerate} disabled={loading || !canGenerate}>
              Generate Bootstrap
            </Button>
          </div>
        </div>

        <div className="space-y-5">
          {bootstrap && (
            <div className="premium-card-soft p-4">
              <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                <div>
                  <p className="premium-kicker">Generated Target</p>
                  <p className="mt-1 text-sm font-semibold text-white">
                    {bootstrap.mode === "gpo"
                      ? "GPO / Trusted Domain deployment"
                      : bootstrap.platform === "windows"
                      ? "Windows Service install"
                      : `${bootstrap.platform} bootstrap`}
                  </p>
                </div>
                <div className="grid gap-2 text-xs font-medium text-slate-300 sm:grid-cols-2">
                  <span className="rounded-md border border-white/10 bg-slate-950/60 px-2.5 py-1.5">
                    backend_url: {bootstrap.backend_url}
                  </span>
                  {bootstrap.mode === "token" && (
                    <span className="rounded-md border border-white/10 bg-slate-950/60 px-2.5 py-1.5">
                      token:{" "}
                      {selectedToken
                        ? `#${selectedToken.id} ${selectedToken.name}`
                        : bootstrap.enrollment_token_id
                        ? `#${bootstrap.enrollment_token_id}`
                        : "—"}
                    </span>
                  )}
                  {bootstrap.mode === "gpo" && (
                    <span className="rounded-md border border-white/10 bg-slate-950/60 px-2.5 py-1.5">
                      mode: Trusted Domain / GPO
                    </span>
                  )}
                </div>
              </div>
              {bootstrap.platform === "windows" && (
                <div className="mt-3 flex gap-2 rounded-lg border border-amber-300/20 bg-amber-300/10 p-3 text-sm font-semibold text-amber-100">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                  <span>
                    {bootstrap.mode === "gpo"
                      ? "Deploy via GPO as Administrator. Domain-joined machines will enroll automatically."
                      : "Run the Windows Service install script from PowerShell as Administrator."}
                  </span>
                </div>
              )}
            </div>
          )}
          <OutputBlock
            title="Bootstrap command"
            value={bootstrap?.bootstrap_command ?? "Generate a bootstrap to view the command."}
            copied={copied === "command"}
            onCopy={() => bootstrap && copyText("command", bootstrap.bootstrap_command)}
          />
          <OutputBlock
            title={
              bootstrap?.mode === "gpo"
                ? "GPO deployment script (techi-gpo-bootstrap.ps1)"
                : bootstrap?.platform === "windows"
                ? "Windows Service install script"
                : "Bootstrap script"
            }
            value={bootstrap?.bootstrap_script ?? "Script output will appear here."}
            copied={copied === "script"}
            onCopy={() => bootstrap && copyText("script", bootstrap.bootstrap_script)}
          />
          <OutputBlock
            title="Config template"
            value={bootstrap?.config_template ?? "Config template will appear here."}
            copied={copied === "config"}
            onCopy={() => bootstrap && copyText("config", bootstrap.config_template)}
          />
          {bootstrap && (
            <div className="rounded-lg border border-amber-300/20 bg-amber-300/10 p-3 text-sm font-medium text-amber-100">
              {bootstrap.preproduction_notice}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

interface OutputBlockProps {
  title: string;
  value: string;
  copied: boolean;
  onCopy: () => void;
}

function OutputBlock({ title, value, copied, onCopy }: OutputBlockProps) {
  return (
    <div className="premium-card-soft overflow-hidden">
      <div className="flex items-center justify-between border-b border-white/[0.08] px-4 py-3">
        <h3 className="text-sm font-semibold text-white">{title}</h3>
        <button
          type="button"
          onClick={onCopy}
          className="inline-flex items-center gap-2 rounded-md border border-white/10 bg-white/[0.04] px-3 py-1.5 text-xs font-semibold text-slate-100 transition hover:bg-white/[0.08]"
        >
          {copied ? <Check className="h-3.5 w-3.5 text-emerald-300" /> : <Clipboard className="h-3.5 w-3.5" />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre className="max-h-[360px] overflow-auto whitespace-pre-wrap break-words p-4 text-[12px] leading-5 text-slate-200">
        {value}
      </pre>
    </div>
  );
}
