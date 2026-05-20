import { useEffect, useMemo, useState } from "react";
import { Check, Clipboard, Copy, KeyRound, Loader2, MonitorCog, Server } from "lucide-react";
import {
  CreateTokenResponse,
  RustDeskConfig,
  buildWindowsBootstrapCommand,
  buildWindowsBootstrapUrl,
  createEnrollmentToken,
  getRustDeskConfig,
} from "../api/enrollmentBootstrap";
import { Button } from "../components/ui";

type CopyTarget = "command" | "url" | null;

export default function Deployment() {
  const [tokenName, setTokenName] = useState("PC Deployment");
  const [maxUses, setMaxUses] = useState(25);
  const [token, setToken] = useState<CreateTokenResponse | null>(null);
  const [rustdesk, setRustdesk] = useState<RustDeskConfig | null>(null);
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState<CopyTarget>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getRustDeskConfig().then(setRustdesk).catch(() => setRustdesk(null));
  }, []);

  const bootstrapUrl = useMemo(() => token ? buildWindowsBootstrapUrl(token.token) : "", [token]);
  const bootstrapCommand = useMemo(() => token ? buildWindowsBootstrapCommand(token.token) : "", [token]);

  const generateToken = async () => {
    setLoading(true);
    setError(null);
    try {
      const created = await createEnrollmentToken({
        name: tokenName.trim() || "PC Deployment",
        max_uses: Math.max(1, Number(maxUses) || 1),
        expires_at: null,
      });
      setToken(created);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to generate enrollment token");
    } finally {
      setLoading(false);
    }
  };

  const copy = async (target: Exclude<CopyTarget, null>, value: string) => {
    await navigator.clipboard.writeText(value);
    setCopied(target);
    window.setTimeout(() => setCopied(null), 1600);
  };

  return (
    <section className="premium-page space-y-5">
      <div className="premium-card overflow-hidden p-5 md:p-6">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <p className="premium-kicker">Deployment</p>
            <h1 className="mt-2 text-2xl font-semibold text-white">Windows One-Command Bootstrap</h1>
            <p className="mt-2 max-w-2xl text-sm font-medium leading-6 text-slate-300">
              Generate an enrollment token, copy the PowerShell command, and run it on a new PC.
              The bootstrap installs RustDesk, configures the TECHI server, installs the agent service,
              enrolls the device, and starts heartbeat reporting.
            </p>
          </div>
          <div className="rounded-lg border border-emerald-400/20 bg-emerald-400/[0.06] px-3 py-2 text-xs font-semibold text-emerald-200">
            Windows 10/11 · Server 2019/2022
          </div>
        </div>
      </div>

      <div className="grid gap-5 xl:grid-cols-[380px_minmax(0,1fr)]">
        <div className="premium-card-soft p-5">
          <div className="mb-4 flex items-center gap-2">
            <KeyRound className="h-4 w-4 text-techi-orange" />
            <h2 className="text-base font-semibold text-white">Enrollment Token</h2>
          </div>

          <div className="space-y-4">
            <label className="block">
              <span className="mb-1.5 block text-xs font-semibold text-slate-200">Token name</span>
              <input
                value={tokenName}
                onChange={(event) => setTokenName(event.target.value)}
                className="w-full rounded-lg border border-white/10 bg-slate-950 px-3 py-2.5 text-sm font-medium text-white outline-none transition focus:border-techi-orange/60"
              />
            </label>
            <label className="block">
              <span className="mb-1.5 block text-xs font-semibold text-slate-200">Maximum PCs</span>
              <input
                type="number"
                min={1}
                value={maxUses}
                onChange={(event) => setMaxUses(Number(event.target.value))}
                className="w-full rounded-lg border border-white/10 bg-slate-950 px-3 py-2.5 text-sm font-medium text-white outline-none transition focus:border-techi-orange/60"
              />
            </label>
            {error && (
              <div className="rounded-lg border border-red-400/20 bg-red-500/10 p-3 text-sm font-medium text-red-200">
                {error}
              </div>
            )}
            <Button type="button" onClick={() => void generateToken()} disabled={loading} className="w-full justify-center">
              {loading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <KeyRound className="mr-2 h-4 w-4" />}
              Generate Token
            </Button>
          </div>

          <div className="mt-5 rounded-lg border border-white/10 bg-slate-950/70 p-3">
            <div className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-slate-400">
              <Server className="h-3.5 w-3.5" />
              RustDesk Config
            </div>
            <dl className="space-y-1 text-xs text-slate-300">
              <div className="flex justify-between gap-3"><dt>Server</dt><dd className="font-mono">{rustdesk?.server_host ?? "loading"}</dd></div>
              <div className="flex justify-between gap-3"><dt>Relay</dt><dd className="font-mono">{rustdesk?.relay_host ?? "loading"}</dd></div>
              <div className="flex justify-between gap-3"><dt>Key</dt><dd className="max-w-[190px] truncate font-mono">{rustdesk?.public_key ?? "loading"}</dd></div>
            </dl>
          </div>
        </div>

        <div className="premium-card-soft p-5">
          <div className="mb-4 flex items-center gap-2">
            <MonitorCog className="h-4 w-4 text-techi-orange" />
            <h2 className="text-base font-semibold text-white">Technician Command</h2>
          </div>

          {token ? (
            <div className="space-y-4">
              <div>
                <div className="mb-2 flex items-center justify-between gap-3">
                  <span className="text-xs font-semibold text-slate-200">Run in elevated PowerShell</span>
                  <Button size="sm" type="button" onClick={() => void copy("command", bootstrapCommand)}>
                    {copied === "command" ? <Check className="mr-1.5 h-3.5 w-3.5" /> : <Copy className="mr-1.5 h-3.5 w-3.5" />}
                    {copied === "command" ? "Copied" : "Copy"}
                  </Button>
                </div>
                <pre className="overflow-x-auto rounded-lg border border-white/10 bg-slate-950 p-4 text-xs font-semibold leading-6 text-emerald-200">
                  {bootstrapCommand}
                </pre>
              </div>

              <div>
                <div className="mb-2 flex items-center justify-between gap-3">
                  <span className="text-xs font-semibold text-slate-200">Direct bootstrap URL</span>
                  <Button size="sm" type="button" onClick={() => void copy("url", bootstrapUrl)}>
                    {copied === "url" ? <Check className="mr-1.5 h-3.5 w-3.5" /> : <Clipboard className="mr-1.5 h-3.5 w-3.5" />}
                    {copied === "url" ? "Copied" : "Copy URL"}
                  </Button>
                </div>
                <pre className="overflow-x-auto rounded-lg border border-white/10 bg-slate-950 p-4 text-xs leading-6 text-slate-300">
                  {bootstrapUrl}
                </pre>
              </div>

              <div className="rounded-lg border border-blue-400/15 bg-blue-400/[0.06] p-4 text-sm leading-6 text-blue-100">
                Run the command once on the target PC. Safe retries are supported: existing RustDesk and
                TechiAgent services are updated and restarted, the agent binary is hash-checked when available,
                and logs are written to <code className="font-mono text-blue-200">C:\ProgramData\TECHI\logs</code>.
              </div>
            </div>
          ) : (
            <div className="rounded-lg border border-white/10 bg-slate-950/60 p-6 text-sm font-medium text-slate-400">
              Generate a token to reveal the one-command deployment string.
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
