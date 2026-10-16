import { useEffect, useMemo, useState } from "react";
import type { CSSProperties } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Monitor,
  RefreshCcw,
  ShieldAlert,
  ShieldQuestion,
  X,
  XCircle,
} from "lucide-react";

import {
  ReenrollmentRequest,
  approveReenrollment,
  listReenrollmentRequests,
  rejectReenrollment,
} from "../api/reenrollment";
import { Button, EmptyState, PageHeader } from "../components/ui";
import ConfirmationModal from "../components/ConfirmationModal";
import { useAuth } from "../auth/AuthContext";
import { TONE } from "../utils/deviceStatus";
import { formatLocalDateTime, timeAgo } from "../utils/time";

type Decision = { request: ReenrollmentRequest; kind: "approve" | "reject" };

function MatchBadge({ by }: { by: string }) {
  const label = by === "rustdesk_id" ? "Remote Support ID" : "Hostname + IP";
  const tone = by === "rustdesk_id" ? TONE.warning : TONE.info;
  return (
    <span className="th-status-chip" style={{ "--chip-tone": tone } as CSSProperties}>
      <ShieldQuestion className="h-3 w-3" style={{ color: tone }} />
      Matched by {label}
    </span>
  );
}

function Field({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div className="min-w-0">
      <div className="text-[11px] font-medium uppercase tracking-wide" style={{ color: "var(--th-text-faint)" }}>
        {label}
      </div>
      <div className="truncate text-[13px]" style={{ color: "var(--th-text-primary)" }}>
        {value && value.trim() ? value : "—"}
      </div>
    </div>
  );
}

export default function Reenrollment() {
  const { can } = useAuth();
  const canManage = can("admin");

  const [requests, setRequests] = useState<ReenrollmentRequest[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [decision, setDecision] = useState<Decision | null>(null);
  const [deciding, setDeciding] = useState(false);

  const load = async () => {
    try {
      setLoading(true);
      setError(null);
      setRequests(await listReenrollmentRequests("pending"));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load re-enrollment requests");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const handleDecision = async () => {
    if (!decision) return;
    try {
      setDeciding(true);
      if (decision.kind === "approve") await approveReenrollment(decision.request.id);
      else await rejectReenrollment(decision.request.id);
      setRequests((prev) => prev.filter((r) => r.id !== decision.request.id));
      setDecision(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to apply the decision");
    } finally {
      setDeciding(false);
    }
  };

  const denied = useMemo(() => /Permission denied|Insufficient role/.test(error ?? ""), [error]);

  if (denied || !canManage) {
    return (
      <section className="premium-page th-onb space-y-4">
        <PageHeader title="Re-enrollment review" description="Devices another agent tried to take over." />
        <div className="th-onb-card th-onb-enter">
          <EmptyState
            icon={<ShieldAlert className="h-5 w-5" />}
            title="Access denied"
            description="Only admins and owners can review re-enrollment requests."
          />
        </div>
      </section>
    );
  }

  return (
    <section className="premium-page th-onb space-y-4">
      <PageHeader
        title="Re-enrollment review"
        description="When an agent enrols onto a device that already belongs to another agent, the device is held here instead of being taken over. Approve to hand the device to the new agent, or reject to keep them as two separate devices."
        actions={
          <Button variant="secondary" size="sm" onClick={() => void load()} disabled={loading}>
            <RefreshCcw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
            Refresh
          </Button>
        }
      />

      {error && !denied && (
        <div
          className="th-onb-note th-onb-reveal"
          style={{ "--onb-tone": "var(--th-status-critical)" } as CSSProperties}
          role="alert"
        >
          <AlertTriangle className="h-4 w-4" />
          <span className="flex-1">{error}</span>
          <button type="button" className="th-onb-action !h-5 !w-5" onClick={() => setError(null)} aria-label="Dismiss">
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {loading && requests.length === 0 ? (
        <div className="th-alerts-scroll" aria-busy="true" aria-label="Loading requests">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="th-alerts-skeleton" style={{ opacity: 1 - i * 0.2 }} />
          ))}
        </div>
      ) : requests.length === 0 ? (
        <div className="th-onb-card th-onb-enter">
          <EmptyState
            icon={<CheckCircle2 className="h-5 w-5" style={{ color: TONE.online }} />}
            title="Nothing to review"
            description="No device has been held for a re-enrollment decision."
          />
        </div>
      ) : (
        <div className="space-y-4">
          {requests.map((r, index) => (
            <article key={r.id} className="th-onb-card th-onb-enter" style={{ "--i": index } as CSSProperties}>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="flex min-w-0 items-center gap-2.5">
                  <span className="th-onb-icon" style={{ "--onb-tone": TONE.warning } as CSSProperties}>
                    <Monitor className="h-4 w-4" />
                  </span>
                  <div className="min-w-0">
                    <div className="text-[15px] font-semibold" style={{ color: "var(--th-text-primary)" }}>
                      {r.device_hostname || `Device #${r.device_id}`}
                    </div>
                    <div className="text-[12px]" style={{ color: "var(--th-text-muted)" }}>
                      Device #{r.device_id} · a new agent matched it {timeAgo(r.created_at)}
                    </div>
                  </div>
                </div>
                <MatchBadge by={r.matched_by} />
              </div>

              <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <Field label="New agent host" value={r.hostname} />
                <Field label="User" value={r.current_user} />
                <Field label="Domain" value={r.domain} />
                <Field label="Remote Support ID" value={r.rustdesk_id} />
                <Field label="Public IP" value={r.public_ip} />
                <Field label="Local IP" value={r.local_ip} />
                <Field label="OS" value={r.os_caption} />
                <Field label="Enrolled with token" value={r.token_name} />
              </div>

              <div className="mt-3 text-[12px]" style={{ color: "var(--th-text-faint)" }}>
                Meanwhile it runs as device #{r.new_device_id} · first seen {formatLocalDateTime(r.created_at)}
              </div>

              <div className="mt-4 flex flex-wrap justify-end gap-2">
                <Button variant="secondary" size="sm" onClick={() => setDecision({ request: r, kind: "reject" })}>
                  <XCircle className="h-3.5 w-3.5" />
                  Keep separate
                </Button>
                <Button size="sm" onClick={() => setDecision({ request: r, kind: "approve" })}>
                  <CheckCircle2 className="h-3.5 w-3.5" />
                  Hand device over
                </Button>
              </div>
            </article>
          ))}
        </div>
      )}

      {decision && (
        <ConfirmationModal
          title={decision.kind === "approve" ? "Hand the device over" : "Keep them separate"}
          confirmLabel={
            deciding
              ? decision.kind === "approve"
                ? "Handing over"
                : "Keeping separate"
              : decision.kind === "approve"
                ? "Hand device over"
                : "Keep separate"
          }
          destructive={decision.kind === "approve"}
          loading={deciding}
          onClose={() => setDecision(null)}
          onConfirm={() => void handleDecision()}
        >
          {decision.kind === "approve" ? (
            <>
              Move device{" "}
              <span className="font-semibold" style={{ color: "var(--th-text-primary)" }}>
                {decision.request.device_hostname || `#${decision.request.device_id}`}
              </span>{" "}
              to the new agent on{" "}
              <span className="font-semibold" style={{ color: "var(--th-text-primary)" }}>
                {decision.request.hostname || "the new machine"}
              </span>
              ? The device keeps its history, and the placeholder device #{decision.request.new_device_id} is archived.
              Do this when the machine was reinstalled.
            </>
          ) : (
            <>
              Keep device{" "}
              <span className="font-semibold" style={{ color: "var(--th-text-primary)" }}>
                {decision.request.device_hostname || `#${decision.request.device_id}`}
              </span>{" "}
              with its current agent, and leave the new agent as its own device #{decision.request.new_device_id}. Do
              this when they are two genuinely different machines.
            </>
          )}
        </ConfirmationModal>
      )}
    </section>
  );
}
