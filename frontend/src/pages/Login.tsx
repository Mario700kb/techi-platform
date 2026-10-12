import { FormEvent, KeyboardEvent, useEffect, useRef, useState } from "react";
import { Navigate, useLocation, useNavigate } from "react-router-dom";
import {
  Activity,
  AlertCircle,
  ArrowLeft,
  Check,
  Eye,
  EyeOff,
  Info,
  MonitorSmartphone,
  ShieldCheck,
} from "lucide-react";
import { useAuth } from "../auth/AuthContext";
import { useTheme } from "../contexts/ThemeContext";
import { getPreferredDefaultScreen } from "./Settings";
import { SESSION_EXPIRED_FLAG } from "../store/sessionStore";
import pkg from "../../package.json";

const HIGHLIGHTS = [
  { icon: Activity, title: "Live fleet health", text: "Status, alerts and health scores for every managed client." },
  {
    icon: MonitorSmartphone,
    title: "One-click remote support",
    text: "Open TECHI Remote Support sessions straight from the console.",
  },
  { icon: ShieldCheck, title: "Audited access", text: "Every sign-in and operator action is recorded." },
];

export default function Login() {
  const { user, login, completeMfa } = useAuth();
  const { theme } = useTheme();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [capsLock, setCapsLock] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // idle → submitting → success (brief confirmation before the hand-off).
  const [phase, setPhase] = useState<"idle" | "submitting" | "success">("idle");
  const [shakeKey, setShakeKey] = useState(0);
  // Second step of a two-factor sign-in: the challenge from the password step.
  const [mfaToken, setMfaToken] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [useRecoveryCode, setUseRecoveryCode] = useState(false);
  const busy = phase !== "idle";
  // Tell the user WHY they landed here after a 401 (audit finding B9). Read
  // and clear the flag in an effect guarded by ranRef so StrictMode's double
  // invoke cannot swallow it.
  const [sessionExpired, setSessionExpired] = useState(false);
  const ranRef = useRef(false);
  useEffect(() => {
    if (ranRef.current) return;
    ranRef.current = true;
    if (window.sessionStorage.getItem(SESSION_EXPIRED_FLAG) === "1") {
      window.sessionStorage.removeItem(SESSION_EXPIRED_FLAG);
      setSessionExpired(true);
    }
  }, []);
  const navigate = useNavigate();
  const location = useLocation();
  // Honor the preferred landing screen only for a plain login, never
  // overriding a protected-route redirect ("from").
  const target =
    (location.state as { from?: { pathname?: string } } | null)?.from?.pathname || getPreferredDefaultScreen();

  // Already signed in on arrival: go straight through. During our own
  // submit we hold the page for the success animation instead.
  if (user && phase === "idle") return <Navigate to={target} replace />;

  const reducedMotion = typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setPhase("submitting");
    setError(null);
    try {
      if (mfaToken) {
        await completeMfa(mfaToken, code);
      } else {
        const challenge = await login(username, password);
        if (challenge) {
          setMfaToken(challenge.mfaToken);
          setPassword("");
          setPhase("idle");
          return;
        }
      }
      setPhase("success");
      window.setTimeout(() => navigate(target, { replace: true }), reducedMotion ? 0 : 650);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Sign-in failed";
      // An expired challenge (5 min) means starting over from the password.
      if (mfaToken && /expired/i.test(message)) backToPassword();
      setError(message);
      setShakeKey((k) => k + 1);
      setPhase("idle");
    }
  };

  const backToPassword = () => {
    setMfaToken(null);
    setCode("");
    setUseRecoveryCode(false);
    setError(null);
  };

  const codeComplete = useRecoveryCode ? code.replace(/[^0-9a-z]/gi, "").length >= 10 : /^\d{6}$/.test(code);

  const trackCaps = (event: KeyboardEvent<HTMLInputElement>) => setCapsLock(event.getModifierState("CapsLock"));
  const logo = theme === "light" ? "/brand/techi-logo.webp" : "/brand/techi-logo-dark.png";

  return (
    <div className="th-auth" data-phase={phase}>
      {/* Brand panel */}
      <aside className="th-auth-brand">
        <img src={logo} alt="TECHI Connect" className="h-7 w-auto self-start object-contain" />
        <div className="max-w-md">
          <h2
            className="th-enter text-[28px] font-semibold leading-tight tracking-tight"
            style={{ color: "var(--th-text-primary)", animationDelay: "80ms" }}
          >
            Run every managed device from one console.
          </h2>
          <ul className="mt-8 space-y-5">
            {HIGHLIGHTS.map(({ icon: Icon, title, text }, i) => (
              <li key={title} className="th-enter flex gap-3" style={{ animationDelay: `${180 + i * 90}ms` }}>
                <span className="th-auth-feature-icon">
                  <Icon className="h-4 w-4" />
                </span>
                <span>
                  <span className="block text-[14px] font-semibold" style={{ color: "var(--th-text-primary)" }}>
                    {title}
                  </span>
                  <span className="mt-0.5 block text-[13px]" style={{ color: "var(--th-text-muted)" }}>
                    {text}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </div>
        <p className="text-[12px]" style={{ color: "var(--th-text-faint)" }}>
          TECHI Connect · v{pkg.version}
        </p>
      </aside>

      {/* Sign-in form */}
      <main className="th-auth-main">
        <form
          key={shakeKey}
          onSubmit={submit}
          className={`th-enter relative w-full max-w-[360px] ${shakeKey ? "th-shake" : ""}`}
          noValidate
          aria-busy={busy}
        >
          <span className="th-auth-progress" aria-hidden="true" data-active={phase === "submitting"} />
          <img src={logo} alt="TECHI Connect" className="mb-10 h-7 w-auto object-contain lg:hidden" />
          <h1 className="text-[24px] font-semibold tracking-tight" style={{ color: "var(--th-text-primary)" }}>
            {mfaToken ? "Two-factor authentication" : "Sign in to TECHI Connect"}
          </h1>
          <p className="mt-1.5 text-[14px]" style={{ color: "var(--th-text-muted)" }}>
            {!mfaToken
              ? "Use your operator account to continue."
              : useRecoveryCode
                ? "Enter one of the recovery codes you saved when you set up two-factor authentication."
                : "Enter the 6-digit code from your authenticator app."}
          </p>

          {(error || sessionExpired) && (
            <div className="th-auth-notice mt-6" data-tone={error ? "error" : "info"} role={error ? "alert" : "status"}>
              {error ? <AlertCircle className="h-4 w-4 flex-none" /> : <Info className="h-4 w-4 flex-none" />}
              <span>{error ?? "Your session expired. Sign in again to continue."}</span>
            </div>
          )}

          {mfaToken ? (
            <div className="mt-6 space-y-3">
              <label className="block">
                <span className="th-auth-label">{useRecoveryCode ? "Recovery code" : "Authentication code"}</span>
                <input
                  key={useRecoveryCode ? "recovery" : "totp"}
                  className="th-auth-input font-mono tracking-[0.3em]"
                  value={code}
                  onChange={(event) =>
                    setCode(
                      useRecoveryCode
                        ? event.target.value.slice(0, 11)
                        : event.target.value.replace(/\D/g, "").slice(0, 6),
                    )
                  }
                  inputMode={useRecoveryCode ? "text" : "numeric"}
                  autoComplete="one-time-code"
                  autoCapitalize="none"
                  spellCheck={false}
                  placeholder={useRecoveryCode ? "xxxxx-xxxxx" : "123456"}
                  autoFocus
                  required
                  disabled={busy}
                />
              </label>
              <div className="flex items-center justify-between gap-3 text-[12px]">
                <button type="button" className="th-link-btn -ml-2 gap-1" onClick={backToPassword} disabled={busy}>
                  <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" /> Back
                </button>
                <button
                  type="button"
                  className="th-link-btn th-link-btn-primary -mr-2"
                  onClick={() => {
                    setUseRecoveryCode((v) => !v);
                    setCode("");
                  }}
                  disabled={busy}
                >
                  {useRecoveryCode ? "Use the authenticator app" : "Use a recovery code"}
                </button>
              </div>
            </div>
          ) : (
            <div className="mt-6 space-y-4">
              <label className="block">
                <span className="th-auth-label">Username or email</span>
                <input
                  className="th-auth-input"
                  value={username}
                  onChange={(event) => setUsername(event.target.value)}
                  autoComplete="username"
                  autoCapitalize="none"
                  spellCheck={false}
                  autoFocus
                  required
                  disabled={busy}
                />
              </label>
              <label className="block">
                <span className="th-auth-label">Password</span>
                <span className="relative block">
                  <input
                    className="th-auth-input pr-11"
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    onKeyDown={trackCaps}
                    onKeyUp={trackCaps}
                    type={showPassword ? "text" : "password"}
                    autoComplete="current-password"
                    required
                    disabled={busy}
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword((v) => !v)}
                    className="th-icon-btn th-icon-btn-ghost absolute right-1 top-1/2 !min-h-8 !min-w-8 -translate-y-1/2"
                    aria-label={showPassword ? "Hide password" : "Show password"}
                    title={showPassword ? "Hide password" : "Show password"}
                  >
                    {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </span>
                {capsLock && (
                  <span className="mt-1.5 block text-[12px]" style={{ color: "var(--th-status-warning)" }}>
                    Caps Lock is on
                  </span>
                )}
              </label>
            </div>
          )}

          <button
            type="submit"
            disabled={busy || (mfaToken ? !codeComplete : !username.trim() || !password)}
            className="th-btn th-btn-primary th-auth-submit mt-6 flex w-full items-center justify-center gap-2 border"
            data-phase={phase}
            style={{ minHeight: 40 }}
          >
            {phase === "submitting" && (
              <span className="th-spinner" style={{ borderTopColor: "var(--th-on-accent)" }} aria-hidden="true" />
            )}
            {phase === "success" && <Check className="th-pop h-4 w-4" aria-hidden="true" />}
            {phase === "submitting"
              ? mfaToken
                ? "Verifying…"
                : "Signing in…"
              : phase === "success"
                ? "Signed in"
                : mfaToken
                  ? "Verify"
                  : "Sign in"}
          </button>

          <p className="mt-8 flex items-start gap-2 text-[12px] leading-5" style={{ color: "var(--th-text-faint)" }}>
            <ShieldCheck className="mt-0.5 h-3.5 w-3.5 flex-none" />
            Access is limited to authorized operators. Sign-ins are recorded in the audit log.
          </p>
        </form>
      </main>
    </div>
  );
}
