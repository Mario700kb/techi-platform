import { useEffect, useState } from "react";
import { Clock } from "lucide-react";
import { useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import { parseUTC } from "../utils/time";

const WARN_BEFORE_MS = 10 * 60_000;

/**
 * A session ends SESSION_MAX_HOURS after sign-in however active it is. Ten
 * minutes before, say so — an operator mid-way through a remote session
 * should not lose it to a surprise sign-out.
 */
export default function SessionExpiryBanner() {
  const { sessionExpiresAt, logout } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!sessionExpiresAt) return;
    const timer = window.setInterval(() => setNow(Date.now()), 15_000);
    return () => window.clearInterval(timer);
  }, [sessionExpiresAt]);

  if (!sessionExpiresAt) return null;
  const endsAt = parseUTC(sessionExpiresAt)?.getTime();
  if (!endsAt) return null;
  const remaining = endsAt - now;
  if (remaining > WARN_BEFORE_MS || remaining <= 0) return null;
  const minutes = Math.max(1, Math.ceil(remaining / 60_000));

  const signInAgain = () => {
    logout();
    navigate("/login", { replace: true, state: { from: location } });
  };

  return (
    <div
      role="status"
      className="flex flex-none flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-[12px] font-semibold md:px-5"
      style={{
        background: "color-mix(in srgb, var(--th-status-warning) 14%, var(--th-bg-topbar))",
        borderBottom: "1px solid var(--th-status-warning)",
        color: "var(--th-status-warning)",
      }}
    >
      <Clock className="h-3.5 w-3.5 flex-none" aria-hidden="true" />
      <span className="flex-1">
        Your session ends in {minutes} minute{minutes === 1 ? "" : "s"}. Save your work, then sign in again to continue.
      </span>
      <button type="button" className="th-link-btn th-link-btn-primary" onClick={signInAgain}>
        Sign in again
      </button>
    </div>
  );
}
