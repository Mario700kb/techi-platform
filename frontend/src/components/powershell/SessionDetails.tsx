import type { ReactNode } from "react";
import type { ConsoleKind } from "../../api/terminal";
import { clock, PanelSection } from "./parts";

export interface SessionFacts {
  operator: { username: string; role: string } | null;
  startedAt: number;
  /** null until the agent reports it (2.1.30+). */
  version: string | null;
  /** The agent reports finished commands (and failures). */
  reported: boolean;
  commands: number;
  failed: number;
  signedInUser: string | null;
  kind?: ConsoleKind;
}

function Row({ label, children, title }: { label: string; children: ReactNode; title?: string }) {
  return (
    <>
      <dt>{label}</dt>
      <dd title={title}>{children}</dd>
    </>
  );
}

export default function SessionDetails({ facts, className }: { facts: SessionFacts; className?: string }) {
  const { operator, version, reported, commands, failed, signedInUser } = facts;
  const linux = facts.kind === "linux";
  return (
    <PanelSection title="Session" className={className}>
      <dl className="ps-dl" data-testid="ps-session-details">
        <Row label="Operator">{operator ? `${operator.username} (${operator.role})` : "—"}</Row>
        <Row label="Started">
          <span className="tabular-nums">{clock(facts.startedAt)}</span>
          <span className="ps-muted"> · 2FA confirmed</span>
        </Row>
        <Row label="Runs as">{linux ? "root" : "SYSTEM"}</Row>
        {linux ? (
          <Row label="Shell">
            <span className="font-mono text-[12px]">bash</span>
          </Row>
        ) : (
          <Row
            label="PowerShell"
            title={version ? undefined : "Agent 2.1.30 or newer reports the version after the first prompt"}
          >
            <span className="font-mono text-[12px]">{version ?? "—"}</span>
          </Row>
        )}
        <Row
          label="Commands"
          title={
            reported
              ? undefined
              : linux
                ? "The Linux shell does not report failed commands"
                : "This agent does not report failed commands (needs 2.1.30)"
          }
        >
          <span className="tabular-nums" data-testid="ps-command-count">
            {commands}
            <span className="ps-muted"> · </span>
            {reported ? (
              <span style={failed > 0 ? { color: "var(--ps-red)", fontWeight: 600 } : undefined}>{failed} failed</span>
            ) : (
              <span className="ps-muted">—</span>
            )}
          </span>
        </Row>
        <Row label="Recording">
          Everything the console shows<span className="ps-muted"> · kept 180 days</span>
        </Row>
        <Row label="Signed-in user">
          {signedInUser ? (
            <>
              {signedInUser}
              <span className="ps-muted"> · sees nothing</span>
            </>
          ) : (
            <span className="ps-muted">Nobody signed in</span>
          )}
        </Row>
      </dl>
    </PanelSection>
  );
}
