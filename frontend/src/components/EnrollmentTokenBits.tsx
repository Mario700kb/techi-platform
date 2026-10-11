import type { CSSProperties } from "react";

import type { EnrollmentToken } from "../api/enrollmentBootstrap";
import { TONE } from "../utils/deviceStatus";
import { formatCount } from "../utils/number";

// Enrollment-token status, usage and filters, shared by every Onboarding tab
// that lists tokens so the three read the same.

export function usagePercent(token: EnrollmentToken): number {
  if (!token.max_uses) return 0;
  return Math.round((100 * token.use_count) / token.max_uses);
}

export function formatTokenPrefix(tokenPrefix: EnrollmentToken["token_prefix"]): string {
  if (typeof tokenPrefix !== "string") return "legacy";
  const prefix = tokenPrefix.trim();
  return prefix ? `${prefix}…` : "legacy";
}

export const TOKEN_STATE: Record<"active" | "unused" | "used" | "revoked" | "expired", { label: string; tone: string }> = {
  active: { label: "Active", tone: TONE.online },
  unused: { label: "Unused", tone: TONE.info },
  used: { label: "Exhausted", tone: TONE.warning },
  revoked: { label: "Revoked", tone: TONE.critical },
  expired: { label: "Expired", tone: TONE.neutral },
};

export function tokenState(token: EnrollmentToken): keyof typeof TOKEN_STATE {
  if (token.status === "revoked" || token.status === "expired" || token.status === "used") return token.status;
  return token.use_count === 0 ? "unused" : "active";
}

export function TokenStatusChip({ token }: { token: EnrollmentToken }) {
  const state = TOKEN_STATE[tokenState(token)];
  return (
    <span className="th-status-chip" style={{ "--chip-tone": state.tone } as CSSProperties}>
      <i />
      {state.label}
    </span>
  );
}

export function UsageMeter({ token }: { token: EnrollmentToken }) {
  const pct = usagePercent(token);
  const tone = token.usage_warning === "critical" ? TONE.critical : token.usage_warning ? TONE.warning : "var(--th-accent)";
  return (
    <span className="inline-flex items-center gap-2.5" title={`${pct}% of max uses`}>
      <span className="th-onb-meter" aria-hidden="true"><i style={{ width: `${Math.min(pct, 100)}%`, "--meter-tone": tone } as CSSProperties} /></span>
      <span className="text-[12px] font-medium tabular-nums" style={{ color: token.usage_warning ? tone : "var(--th-text-secondary)" }}>
        {formatCount(token.use_count)}/{formatCount(token.max_uses)}
      </span>
    </span>
  );
}

export type TokenFilter = "all" | keyof typeof TOKEN_STATE;

export const TOKEN_FILTERS: { id: TokenFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "active", label: "Active" },
  { id: "unused", label: "Unused" },
  { id: "used", label: "Exhausted" },
  { id: "revoked", label: "Revoked" },
  { id: "expired", label: "Expired" },
];
