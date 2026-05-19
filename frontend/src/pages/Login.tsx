import { FormEvent, useState } from "react";
import { Navigate, useLocation, useNavigate } from "react-router-dom";
import { LockKeyhole } from "lucide-react";
import { useAuth } from "../auth/AuthContext";

export default function Login() {
  const { user, login } = useAuth();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();
  const target = (location.state as { from?: { pathname?: string } } | null)?.from?.pathname || "/";

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
      className="flex min-h-screen items-center justify-center px-4"
      style={{ background: "var(--th-bg-page)", color: "var(--th-text-primary)" }}
    >
      <form
        onSubmit={submit}
        className="box-border w-full max-w-sm rounded-xl p-5 shadow-2xl"
        style={{
          maxWidth: "min(24rem, calc(100vw - 2rem))",
          border: "1px solid var(--th-border-card)",
          background: "var(--th-bg-surface)",
        }}
      >
        <div className="mb-5 flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg border border-techi-orange/20 bg-techi-orange/10">
            <LockKeyhole className="h-4 w-4 text-orange-400" />
          </div>
          <div>
            <p className="premium-kicker">TECHI MSP</p>
            <h1 className="text-lg font-semibold" style={{ color: "var(--th-text-primary)" }}>Operator login</h1>
          </div>
        </div>
        {error && (
          <div className="mb-3 rounded-lg border border-red-400/20 bg-red-500/10 px-3 py-2 text-xs font-medium text-red-400">
            {error}
          </div>
        )}
        <div className="space-y-3">
          <input
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            placeholder="Username or email"
            className="w-full rounded-lg border px-3 py-2 text-sm font-medium outline-none transition focus:border-techi-orange/60"
            style={{
              borderColor: "var(--th-border-input)",
              background: "var(--th-bg-input)",
              color: "var(--th-text-primary)",
            }}
          />
          <input
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            placeholder="Password"
            type="password"
            className="w-full rounded-lg border px-3 py-2 text-sm font-medium outline-none transition focus:border-techi-orange/60"
            style={{
              borderColor: "var(--th-border-input)",
              background: "var(--th-bg-input)",
              color: "var(--th-text-primary)",
            }}
          />
          <button
            type="submit"
            disabled={busy || !username.trim() || !password}
            className="w-full rounded-lg border border-techi-orange/25 bg-techi-orange/15 px-3 py-2 text-sm font-semibold text-techi-orange transition hover:bg-techi-orange/25 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Sign in
          </button>
        </div>
      </form>
    </div>
  );
}
