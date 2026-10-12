import type { CSSProperties } from "react";
import { LogOut, ShieldCheck } from "lucide-react";
import { useAuth } from "../auth/AuthContext";
import MfaSetupFlow from "../components/security/MfaSetupFlow";
import Button from "../components/ui/Button";

/**
 * Shown instead of the console when the operator's role requires two-factor
 * authentication and they have not set it up. The API refuses everything
 * else until they do, so there is nothing to navigate to meanwhile.
 */
export default function MfaEnrollment() {
  const { user, logout, reloadSession } = useAuth();
  const account = user?.email || user?.username || "";

  return (
    <main className="flex min-h-screen items-center justify-center p-4" style={{ background: "var(--th-bg-main)" }}>
      <div className="th-onb th-onb-card w-full max-w-[560px]">
        <div className="th-onb-body flex flex-col gap-5 !p-6">
          <div className="flex items-start gap-3">
            <span className="th-onb-icon flex-none" style={{ "--onb-tone": "var(--th-accent)" } as CSSProperties}>
              <ShieldCheck className="h-4 w-4" />
            </span>
            <div>
              <h1 className="text-[20px] font-semibold tracking-tight" style={{ color: "var(--th-text-primary)" }}>
                Set up two-factor authentication
              </h1>
              <p className="mt-1 text-[13px]" style={{ color: "var(--th-text-muted)" }}>
                Your role ({user?.role}) requires a code from your phone at sign-in. It takes about a minute, and you
                only do it once.
              </p>
            </div>
          </div>
          <MfaSetupFlow account={account} formId="mfa-enrol-form" inlineSubmit onDone={() => void reloadSession()} />
          <div className="flex justify-start border-t pt-4" style={{ borderColor: "var(--th-border-subtle)" }}>
            <Button variant="ghost" size="sm" onClick={logout}>
              <LogOut className="h-3.5 w-3.5" /> Sign out
            </Button>
          </div>
        </div>
      </div>
    </main>
  );
}
