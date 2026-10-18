import type { ReactNode } from "react";
import { Download, Loader2 } from "lucide-react";
import type { DeviceInventory, SecurityPosture } from "../api/inventory";
import { TONE } from "../utils/deviceStatus";
import { formatDateTime, timeAgo } from "../utils/time";
import { compareVersions } from "../utils/version";
import { Button, SectionHeader } from "./ui";

/** The first agent that reports the security posture. */
const SECURITY_POSTURE_AGENT = "2.1.31";

const SIGNATURES_STALE_DAYS = 7;

interface Fact {
  label: string;
  value: string;
  tone: string;
  sub?: string;
  /** Native tooltip for the whole fact (e.g. the list of local admins). */
  title?: string;
}

const onOff = (value: boolean | null, offTone: string = TONE.warning): Pick<Fact, "value" | "tone"> =>
  value === true
    ? { value: "On", tone: TONE.online }
    : value === false
      ? { value: "Off", tone: offTone }
      : { value: "Unknown", tone: TONE.neutral };

function signatureAge(days: number | null): string | null {
  if (days == null) return null;
  if (days === 0) return "signatures today";
  return `signatures ${days} d old`;
}

function antivirusFact(p: SecurityPosture): Fact {
  const { defender } = p;
  if (p.third_party_av.length > 0) {
    const [first, ...rest] = p.third_party_av;
    return {
      label: "Antivirus",
      value: rest.length ? `${first} +${rest.length}` : first,
      tone: TONE.online,
      sub: defender.present ? "Third-party · Defender passive" : "Third-party",
      title: p.third_party_av.join("\n"),
    };
  }
  if (defender.present && defender.antivirus_enabled !== false) {
    const realtimeOff = defender.realtime_enabled === false;
    const stale = (defender.signature_age_days ?? 0) > SIGNATURES_STALE_DAYS;
    const realtime =
      defender.realtime_enabled === true ? "Real-time on" : realtimeOff ? "Real-time off" : "Real-time unknown";
    return {
      label: "Antivirus",
      value: "Defender",
      tone: realtimeOff || stale ? TONE.warning : TONE.online,
      sub: [realtime, signatureAge(defender.signature_age_days)].filter(Boolean).join(" · "),
    };
  }
  return {
    label: "Antivirus",
    value: "None active",
    tone: TONE.critical,
    sub: defender.present ? "Defender is off" : "No antivirus reported",
  };
}

function firewallFact(p: SecurityPosture): Fact {
  const profiles = [
    ["Domain", p.firewall.domain],
    ["Private", p.firewall.private],
    ["Public", p.firewall.public],
  ] as const;
  const off = profiles.filter(([, v]) => v === false).map(([n]) => n);
  const known = profiles.filter(([, v]) => v !== null);
  const sub = profiles.map(([n, v]) => `${n} ${v === true ? "on" : v === false ? "off" : "?"}`).join(" · ");
  if (off.length > 0)
    return { label: "Firewall", value: `Off: ${off.join(", ")}`, tone: TONE.critical, sub, title: sub };
  if (known.length === 0) return { label: "Firewall", value: "Unknown", tone: TONE.neutral, sub: "Not reported" };
  return { label: "Firewall", value: "On", tone: TONE.online, sub, title: sub };
}

function bitlockerFact(p: SecurityPosture): Fact {
  const { system_drive: drive, protection, encryption_percent: pct } = p.bitlocker;
  const encrypted = pct != null ? `${Math.round(pct)}% encrypted` : null;
  if (protection === "on") {
    return { label: `BitLocker ${drive}`, value: "On", tone: TONE.online, sub: encrypted ?? undefined };
  }
  if (protection === "off") {
    return {
      label: `BitLocker ${drive}`,
      value: "Off",
      tone: TONE.warning,
      sub: pct ? (encrypted ?? undefined) : "Not encrypted",
    };
  }
  return { label: `BitLocker ${drive}`, value: "Unknown", tone: TONE.neutral, sub: "Not available or not readable" };
}

function securityFacts(p: SecurityPosture): Fact[] {
  const admins = p.local_admins;
  return [
    antivirusFact(p),
    firewallFact(p),
    bitlockerFact(p),
    {
      label: "Local admins",
      value: String(admins.length),
      tone: TONE.info,
      sub: admins.length ? admins.join(", ") : "None reported",
      title: admins.length ? admins.join("\n") : undefined,
    },
    { label: "UAC", ...onOff(p.uac_enabled) },
    {
      label: "Secure Boot",
      ...onOff(p.secure_boot),
      sub: p.secure_boot == null ? "BIOS or not supported" : undefined,
    },
  ];
}

interface DeviceSecurityCardProps {
  agentVersion?: string | null;
  /** The device inventory, when it has been loaded this session. */
  inventory: DeviceInventory | null;
  loading: boolean;
  error: string | null;
  onLoad: () => void;
}

/**
 * Overview card for a Windows device: antivirus, firewall, BitLocker on the
 * system drive, UAC, Secure Boot and local administrators, as the agent read
 * them (every six hours). It comes with the inventory, which the drawer loads
 * only on request, so until then the card offers to load it.
 */
export default function DeviceSecurityCard({
  agentVersion,
  inventory,
  loading,
  error,
  onLoad,
}: DeviceSecurityCardProps) {
  const posture = inventory?.security_posture ?? null;
  const agentTooOld = compareVersions(agentVersion, SECURITY_POSTURE_AGENT) === "outdated";
  const collectedAt = inventory?.security_collected_at ?? posture?.collected_at ?? null;

  let body: ReactNode;
  if (posture) {
    body = (
      <dl className="grid grid-cols-2 gap-x-4 gap-y-2.5" aria-label="Security posture">
        {securityFacts(posture).map((f) => (
          <div key={f.label} className="min-w-0" title={f.title}>
            <dt className="text-[12px]" style={{ color: "var(--th-text-muted)" }}>
              {f.label}
            </dt>
            <dd
              className="mt-0.5 flex min-w-0 items-center gap-2 text-[13px] font-semibold"
              style={{ color: "var(--th-text-primary)" }}
            >
              <span className="h-2 w-2 flex-none rounded-full" style={{ background: f.tone }} aria-hidden />
              <span className="truncate">{f.value}</span>
            </dd>
            {f.sub && (
              <dd className="mt-0.5 truncate text-[12px]" style={{ color: "var(--th-text-faint)" }}>
                {f.sub}
              </dd>
            )}
          </div>
        ))}
      </dl>
    );
  } else if (agentTooOld) {
    body = (
      <p className="text-[13px]" style={{ color: "var(--th-text-muted)" }}>
        Needs agent {SECURITY_POSTURE_AGENT}
        {agentVersion ? ` (this device runs ${agentVersion})` : ""}.
      </p>
    );
  } else if (inventory) {
    body = (
      <p className="text-[13px]" style={{ color: "var(--th-text-muted)" }}>
        {agentVersion
          ? "Not reported yet — the agent reads it every 6 hours."
          : `Needs agent ${SECURITY_POSTURE_AGENT}.`}
      </p>
    );
  } else {
    body = (
      <div className="flex items-center justify-between gap-3">
        <p className="min-w-0 text-[13px]" style={{ color: "var(--th-text-muted)" }}>
          {error ? `Could not load: ${error}` : "Antivirus, firewall, BitLocker, UAC, Secure Boot, local admins."}
        </p>
        <Button size="sm" variant="secondary" className="flex-none" onClick={onLoad} disabled={loading}>
          {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
          {loading ? "Loading…" : "Show security"}
        </Button>
      </div>
    );
  }

  return (
    <section className="mb-3.5" aria-label="Security">
      <SectionHeader
        title="Security"
        meta={
          posture && collectedAt
            ? `Collected ${timeAgo(collectedAt)}`
            : agentTooOld
              ? "Not on this agent"
              : inventory
                ? "Read every 6 hours"
                : "Loads on request"
        }
        metaTitle={posture && collectedAt ? formatDateTime(collectedAt) : undefined}
      />
      <div className="th-drawer-card">{body}</div>
    </section>
  );
}
