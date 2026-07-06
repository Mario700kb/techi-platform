import { FormEvent, useEffect, useRef, useState } from "react";
import { Navigate, useLocation, useNavigate } from "react-router-dom";
import { LockKeyhole, ShieldCheck } from "lucide-react";
import { useAuth } from "../auth/AuthContext";
import { getPreferredDefaultScreen } from "./Settings";
import { SESSION_EXPIRED_FLAG } from "../store/sessionStore";

export default function Login() {
  const { user, login } = useAuth();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Mobile UI 2.0 (audit finding B9): tell the user WHY they landed here
  // instead of silently dropping them on /login after a 401. Read (and
  // clear) the flag in an effect, not a useState lazy initializer or
  // module-scope code — the former is double-invoked by React StrictMode
  // in dev (the second call finds the flag already cleared by the first
  // and silently drops it), and the latter would miss a client-side
  // redirect to /login that happens long after this module was first
  // imported. The ranRef guard keeps the effect's own StrictMode
  // double-invoke from doing the same thing to itself.
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
  // Mobile UI 2.0 (MOBILE-DESIGN-SPEC.md — Settings/Preferences): honor the
  // user's preferred landing screen only for a plain login, never
  // overriding a protected-route redirect ("from").
  const target =
    (location.state as { from?: { pathname?: string } } | null)?.from?.pathname || getPreferredDefaultScreen();

  if (user) return <Navigate to={target} replace />;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(username, password);
      navigate(target, { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Login failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="flex min-h-screen items-center justify-center px-4 py-8"
      style={{ background: "#0A0A0B", color: "#F5F5F7" }}
    >
      <form
        onSubmit={submit}
        className="box-border w-full rounded-xl p-6 shadow-2xl sm:p-7"
        style={{
          maxWidth: "min(27rem, calc(100vw - 2rem))",
          border: "1px solid rgba(255, 255, 255, 0.10)",
          background: "#131316",
          boxShadow: "0 24px 70px rgba(0, 0, 0, 0.45), inset 0 1px 0 rgba(255, 255, 255, 0.05)",
        }}
      >
        <div className="mb-7 text-center">
          <img
            src="/brand/techi-logo-dark.png"
            alt="TECHI"
            className="mx-auto h-10 w-auto object-contain"
            onError={(e) => {
              e.currentTarget.src = "/brand/techi-mark-dark.png";
            }}
          />
          <div className="mx-auto mt-5 flex h-11 w-11 items-center justify-center rounded-lg border border-techi-orange/25 bg-techi-orange/10">
            <LockKeyhole className="h-5 w-5 text-orange-300" />
          </div>
          <div className="mt-4">
            <h1 className="text-xl font-semibold text-techi-orange">TECHI MSP Operator Login</h1>
            <p className="mt-1 text-sm font-medium text-slate-400">Secure access for TECHI operators</p>
          </div>
        </div>
        {sessionExpired && !error && (
          <div className="mb-4 rounded-lg border border-amber-400/25 bg-amber-500/10 px-3 py-2 text-xs font-semibold text-amber-300">
            Session expired — please sign in again.
          </div>
        )}
        {error && (
          <div className="mb-4 rounded-lg border border-red-400/25 bg-red-500/10 px-3 py-2 text-xs font-semibold text-red-300">
            {error}
          </div>
        )}
        <div className="space-y-4">
          <label className="block">
            <span className="mb-1.5 block text-xs font-bold uppercase tracking-[0.08em] text-slate-500">Username</span>
            <input
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              placeholder="Username or email"
              className="w-full rounded-lg border border-white/10 bg-[#1A1A1E] px-3 py-2.5 text-sm font-semibold text-white outline-none transition placeholder:text-slate-600 focus:border-techi-orange/50 focus:ring-4 focus:ring-techi-orange/10"
            />
          </label>
          <label className="block">
            <span className="mb-1.5 block text-xs font-bold uppercase tracking-[0.08em] text-slate-500">Password</span>
            <input
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="Password"
              type="password"
              className="w-full rounded-lg border border-white/10 bg-[#1A1A1E] px-3 py-2.5 text-sm font-semibold text-white outline-none transition placeholder:text-slate-600 focus:border-techi-orange/50 focus:ring-4 focus:ring-techi-orange/10"
            />
          </label>
          <button
            type="submit"
            disabled={busy || !username.trim() || !password}
            className="th-btn mt-1 w-full border border-techi-orange/40 bg-techi-orange px-3 py-2.5 text-sm font-bold text-white transition hover:bg-[#FF6B47] disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy ? "Signing in..." : "Sign in"}
          </button>
        </div>
        <div className="mt-6 flex items-center justify-center gap-2 border-t border-white/[0.06] pt-4 text-xs font-semibold text-slate-500">
          <ShieldCheck className="h-3.5 w-3.5 text-orange-300" />
          <span>Operator console</span>
        </div>
      </form>
    </div>
  );
}
