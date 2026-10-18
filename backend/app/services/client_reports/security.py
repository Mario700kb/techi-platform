"""Security posture from device_inventory.security_json (agents from 2.1.31).

Score 0–100, the sum of these weights for each check the device passes:

    antivirus enabled (Defender or a third-party product)  30
    real-time protection on                                 15
    antivirus signatures at most 7 days old                 10
    firewall on (5 per profile: domain, private, public)    15
    BitLocker on for the system drive                       15
    UAC on                                                   5
    Secure Boot on                                           5
    no local administrators beyond the built-in ones         5

A value the device could not read (null / "unknown") is not counted against
it. With a third-party antivirus, Defender's real-time and signature values
are not meaningful (Defender is passive) and the product is trusted for both.
Built-in administrators: the "Administrator" account, "Domain Admins" and the
Entra ID role groups (SIDs S-1-12-1-…).
"""
from typing import List, Optional, Tuple

from app.schemas.client_report import ReportKpi, ReportSection
from app.services.client_reports.catalog import SECURITY_AGENT_VERSION
from app.services.client_reports.common import (
    CRIT, INFO, TONE_OF, WARN, Built, Issue, Recommendation, ReportContext, agent_at_least, col, device_cells,
    device_columns, iso, is_windows, json_dict, nice_date, pct, plural,
)

KEY = "security_posture"
WEIGHTS = {"antivirus": 30, "realtime": 15, "signatures": 10, "firewall": 15, "bitlocker": 15,
           "uac": 5, "secure_boot": 5, "admins": 5}
SIGNATURE_MAX_DAYS = 7
PROFILES = ("domain", "private", "public")
_BUILTIN_ADMINS = {"administrator", "domain admins"}
SEVERITY_LABEL = {CRIT: "Critical", WARN: "Warning", INFO: "Info"}


def _extra_admins(names) -> List[str]:
    extra = []
    for name in names or []:
        if not isinstance(name, str) or not name.strip():
            continue
        short = name.replace("/", "\\").split("\\")[-1].strip()
        if short.lower() in _BUILTIN_ADMINS or short.upper().startswith("S-1-12-1-"):
            continue
        extra.append(name.strip())
    return extra


def evaluate(security: dict) -> Tuple[int, List[Tuple[int, str, str]], dict]:
    """(score, [(severity, check, text)], summary values) for one security_json."""
    defender = security.get("defender") if isinstance(security.get("defender"), dict) else {}
    third = [str(p) for p in security.get("third_party_av") or [] if p]
    firewall = security.get("firewall") if isinstance(security.get("firewall"), dict) else {}
    bitlocker = security.get("bitlocker") if isinstance(security.get("bitlocker"), dict) else {}
    score = 0
    issues: List[Tuple[int, str, str]] = []

    defender_on = bool(defender.get("present")) and defender.get("antivirus_enabled") is True
    defender_unknown = bool(defender.get("present")) and defender.get("antivirus_enabled") is None
    antivirus = ", ".join(third) if third else ("Defender" if defender_on else "Defender (unknown)" if defender_unknown else None)
    av_on = bool(third) or defender_on or defender_unknown
    if av_on:
        score += WEIGHTS["antivirus"]
    else:
        issues.append((CRIT, "antivirus", "No antivirus enabled"))

    realtime = defender.get("realtime_enabled")
    if av_on and (third or realtime is not False):
        score += WEIGHTS["realtime"]
    elif av_on:
        issues.append((CRIT, "realtime", "Real-time protection off"))

    age = defender.get("signature_age_days")
    if av_on and (third or not isinstance(age, (int, float)) or age <= SIGNATURE_MAX_DAYS):
        score += WEIGHTS["signatures"]
    elif av_on:
        issues.append((WARN, "signatures", f"Antivirus signatures {int(age)} days old"))

    off = [p for p in PROFILES if firewall.get(p) is False]
    score += WEIGHTS["firewall"] - len(off) * WEIGHTS["firewall"] // len(PROFILES)
    if off:
        issues.append((CRIT if len(off) == len(PROFILES) else WARN, "firewall",
                       f"Firewall off: {', '.join(p.title() for p in off)}"))

    protection = (bitlocker.get("protection") or "unknown").lower()
    drive = bitlocker.get("system_drive") or "C:"
    if protection == "off":
        issues.append((WARN, "bitlocker", f"BitLocker off on {drive}"))
    else:
        score += WEIGHTS["bitlocker"]

    if security.get("uac_enabled") is False:
        issues.append((WARN, "uac", "UAC off"))
    else:
        score += WEIGHTS["uac"]
    if security.get("secure_boot") is False:
        issues.append((INFO, "secure_boot", "Secure Boot off"))
    else:
        score += WEIGHTS["secure_boot"]
    extra = _extra_admins(security.get("local_admins"))
    if extra:
        shown = ", ".join(extra[:4]) + (", …" if len(extra) > 4 else "")
        issues.append((INFO, "admins", f"{plural(len(extra), 'extra local administrator')}: {shown}"))
    else:
        score += WEIGHTS["admins"]

    protected = av_on and not any(check in ("antivirus", "realtime") for _, check, _ in issues)
    values = {
        "antivirus": antivirus or "None",
        "firewall": "On" if not off and any(firewall.get(p) for p in PROFILES) else
                    ("Off: " + ", ".join(p.title() for p in off)) if off else "Unknown",
        "bitlocker": {"on": "On", "off": "Off"}.get(protection, "Unknown"),
        "protected": protected,
    }
    return score, issues, values


def _security_of(inventory) -> Optional[dict]:
    raw = getattr(inventory, "security_json", None) if inventory is not None else None
    value = json_dict(raw)
    return value or None


def build(ctx: ReportContext) -> Built:
    inventories = ctx.inventories()
    issue_rows, device_rows, nodata_rows = [], [], []
    counts = {"antivirus": 0, "firewall": 0, "bitlocker": 0, "protected": 0}
    for device in ctx.devices:
        security = _security_of(inventories.get(device.id))
        if security is None:
            if not is_windows(device):
                reason = "Not collected on this platform"
            elif not agent_at_least(device, SECURITY_AGENT_VERSION):
                reason = f"Agent {device.agent_version or 'unknown'}: needs {SECURITY_AGENT_VERSION}"
            else:
                reason = "Not reported yet"
            nodata_rows.append({**device_cells(device), "agent": device.agent_version or "—",
                                "last_seen": iso(device.last_seen), "reason": reason})
            continue
        score, issues, values = evaluate(security)
        checks = {check for _, check, _ in issues}
        counts["antivirus"] += "antivirus" in checks
        counts["firewall"] += "firewall" in checks
        counts["bitlocker"] += "bitlocker" in checks
        counts["protected"] += values["protected"]
        tone = "ok" if score >= 90 else "warn" if score >= 70 else "crit"
        collected = security.get("collected_at")
        device_rows.append({**device_cells(device), "score": score, "antivirus": values["antivirus"],
                            "firewall": values["firewall"], "bitlocker": values["bitlocker"],
                            "issues": len(issues), "collected": collected if isinstance(collected, str) else None,
                            "_tone": tone})
        for severity, _, text in issues:
            issue_rows.append({**device_cells(device), "issue": text, "severity": SEVERITY_LABEL[severity],
                               "score": score, "_tone": TONE_OF[severity], "_rank": severity})

    issue_rows.sort(key=lambda r: (-r.pop("_rank"), r["score"], r["device"].lower()))
    device_rows.sort(key=lambda r: (r["score"], r["device"].lower()))
    nodata_rows.sort(key=lambda r: r["device"].lower())
    with_data = len(device_rows)
    protected = pct(counts["protected"], with_data)
    old_agents = sum(1 for r in nodata_rows if r["reason"].startswith("Agent "))
    if with_data:
        protected_kpi = ReportKpi(label="Protected", value=protected, kind="percent",
                                  tone="ok" if protected >= 95 else "warn" if protected >= 80 else "crit",
                                  hint=f"Antivirus with real-time protection, {counts['protected']} of {with_data}")
    else:
        protected_kpi = ReportKpi(label="Protected", value=f"needs agent {SECURITY_AGENT_VERSION}", kind="text",
                                  tone="info", hint="No device reports its security settings yet")
    summary = [
        protected_kpi,
        ReportKpi(label="No antivirus", value=counts["antivirus"], tone="crit" if counts["antivirus"] else "ok"),
        ReportKpi(label="Firewall off", value=counts["firewall"], tone="warn" if counts["firewall"] else "ok",
                  hint="On at least one profile"),
        ReportKpi(label="System disk not encrypted", value=counts["bitlocker"], tone="warn" if counts["bitlocker"] else "ok",
                  hint="BitLocker off"),
        ReportKpi(label="No data", value=len(nodata_rows), tone="info" if nodata_rows else "neutral",
                  hint=f"{plural(old_agents, 'agent')} older than {SECURITY_AGENT_VERSION}"),
    ]
    sections = [
        ReportSection(
            key="issues", title="Issues", description="One row per device and issue, most serious first.",
            columns=[*device_columns()[:1], col("issue", "Issue"), col("severity", "Severity", "badge"),
                     col("score", "Score", "number")],
            rows=issue_rows, empty="No security issues found." if with_data else "No device reports its security settings yet.",
        ),
        ReportSection(
            key="devices", title="Devices", description="Security score per device, lowest first.",
            columns=[*device_columns(), col("score", "Score", "number"), col("antivirus", "Antivirus"),
                     col("firewall", "Firewall"), col("bitlocker", "BitLocker", "badge"), col("collected", "Checked", "datetime")],
            rows=device_rows, empty=f"No device reports its security settings yet (agent {SECURITY_AGENT_VERSION} or later).",
        ),
        ReportSection(
            key="no_data", title="No data", description="Not counted in the figures above.",
            columns=[*device_columns(), col("agent", "Agent"), col("last_seen", "Last seen", "datetime"), col("reason", "Reason")],
            rows=nodata_rows, empty="Every device reports its security settings.",
        ),
    ]
    notes = ["Score out of 100: antivirus 30, real-time protection 15, signatures up to 7 days old 10, firewall 15 "
             "(5 per profile), BitLocker on the system drive 15, UAC 5, Secure Boot 5, no extra local administrators 5. "
             "A setting the device could not read does not lower the score.",
             f"Collected by agents {SECURITY_AGENT_VERSION} and later at their inventory run."]
    document = ctx.document(key=KEY, title="Security posture", subtitle=f"Settings as of {nice_date(ctx.today)}",
                            summary=summary, sections=sections, notes=notes)

    issues, recs = [], []
    if counts["antivirus"]:
        issues.append(Issue(CRIT, f"{plural(counts['antivirus'], 'device')} without antivirus", KEY, counts["antivirus"]))
        recs.append(Recommendation(95, f"Enable Microsoft Defender or install the antivirus on the {plural(counts['antivirus'], 'device')} without one."))
    realtime_off = sum(1 for r in issue_rows if r["issue"] == "Real-time protection off")
    if realtime_off:
        issues.append(Issue(CRIT, f"{plural(realtime_off, 'device')} with real-time protection off", KEY, realtime_off))
        recs.append(Recommendation(90, f"Turn real-time protection back on for {plural(realtime_off, 'device')}."))
    if counts["firewall"]:
        issues.append(Issue(WARN, f"{plural(counts['firewall'], 'device')} with the firewall off on a profile", KEY, counts["firewall"]))
        recs.append(Recommendation(70, f"Turn the Windows firewall on for every profile on {plural(counts['firewall'], 'device')}."))
    if counts["bitlocker"]:
        issues.append(Issue(WARN, f"{plural(counts['bitlocker'], 'device')} with an unencrypted system disk", KEY, counts["bitlocker"]))
        recs.append(Recommendation(65, f"Enable BitLocker on the system drive of {plural(counts['bitlocker'], 'device')} "
                                       "(a lost laptop then exposes no data)."))
    if old_agents and not with_data:
        recs.append(Recommendation(30, f"Update the agents to {SECURITY_AGENT_VERSION} to see the security posture of the {plural(old_agents, 'device')}."))
    facts = {"protected_pct": protected, "with_data": with_data, "no_antivirus": counts["antivirus"]}
    return Built(document, issues, recs, facts)
