"""Access audit: who reached the client's devices in the period, and how long.

Read from the audit log. Session lengths come from activity_sessions
.session_spans, the same linking the client's Activity tab uses: a Connect
click carries the Remote Support session it started; a Remote Support session
nobody clicked Connect for (someone used the device's ID and password directly)
is listed on its own and flagged. Terminal sessions carry their PowerShell /
bash / SSH session, its end reason and whether it was recorded.
"""
from collections import Counter
from typing import Dict, List, Optional

from sqlalchemy import or_

from app.core.time import ensure_utc
from app.models.audit_log import AuditLog
from app.models.device import Device
from app.models.device_group import DeviceGroup
from app.models.terminal_session import TerminalSession
from app.models.vault_credential import VaultCredential, VaultCredentialAssignment
from app.schemas.client_report import ReportKpi, ReportSection
from app.services.activity_sessions import session_spans
from app.services.audit_service import AuditAction
from app.services.client_reports.common import (
    INFO, WARN, Built, Issue, Recommendation, ReportContext, col, human_duration, iso, json_dict, plural,
)
from app.services.report_output import safe_text

KEY = "access_audit"
MAX_ENTRIES = 5000
_RS_PASSWORD_REVEAL = "reveal_remote_support_password"
_ENGINE = {"powershell": "PowerShell", "pwsh": "PowerShell", "bash": "Bash", "sh": "Shell", "ssh": "SSH"}
_SYSTEM_USERS = {None, "", "rustdesk", "system"}


def _naive(dt):
    return ensure_utc(dt).replace(tzinfo=None)


def _credential_ids(ctx: ReportContext) -> List[int]:
    device_ids = [d.id for d in ctx.devices]
    group_ids = [g for (g,) in ctx.db.query(DeviceGroup.id).filter(DeviceGroup.client_id == ctx.client_id)]
    owned = ctx.db.query(VaultCredential.id).filter(or_(
        VaultCredential.client_id == ctx.client_id,
        VaultCredential.device_id.in_(device_ids or [-1]),
        VaultCredential.group_id.in_(group_ids or [-1]),
    ))
    assigned = ctx.db.query(VaultCredentialAssignment.credential_id).filter(or_(
        VaultCredentialAssignment.client_id == ctx.client_id,
        VaultCredentialAssignment.device_id.in_(device_ids or [-1]),
    ))
    return sorted({i for (i,) in owned} | {i for (i,) in assigned})


def build(ctx: ReportContext) -> Built:
    db = ctx.db
    start, end = _naive(ctx.start), _naive(ctx.end)
    actions = [AuditAction.REMOTE_CONNECT, AuditAction.REMOTE_SESSION_STARTED, AuditAction.TERMINAL_SESSION_OPENED,
               AuditAction.SSH_SESSION_STARTED, AuditAction.CONSOLE_SCRIPT_RUN, AuditAction.REMOTE_SUPPORT_ALARM]
    entries: List[AuditLog] = (
        db.query(AuditLog)
        .filter(AuditLog.client_id == ctx.client_id, AuditLog.action.in_(actions),
                AuditLog.created_at >= start, AuditLog.created_at < end)
        .order_by(AuditLog.created_at.desc(), AuditLog.id.desc())
        .limit(MAX_ENTRIES + 1)
        .all()
    )
    truncated = len(entries) > MAX_ENTRIES
    entries = entries[:MAX_ENTRIES]
    credential_ids = _credential_ids(ctx)
    reveals: List[AuditLog] = (
        db.query(AuditLog)
        .filter(AuditLog.action == "vault_credential_revealed", AuditLog.entity_type == "vault_credential",
                AuditLog.entity_id.in_(credential_ids), AuditLog.created_at >= start, AuditLog.created_at < end)
        .order_by(AuditLog.created_at.desc())
        .limit(MAX_ENTRIES)
        .all()
    ) if credential_ids else []

    details = {e.id: json_dict(e.details_json) for e in entries}
    device_ids = {e.device_id for e in entries if e.device_id}
    names: Dict[int, str] = {d.id: (d.display_name or d.hostname or f"Device #{d.id}") for d in ctx.devices}
    missing = device_ids - set(names)
    if missing:
        for d in db.query(Device).filter(Device.id.in_(missing)):
            names[d.id] = d.display_name or d.hostname or f"Device #{d.id}"

    def device_of(entry: AuditLog) -> Optional[int]:
        return entry.device_id or (entry.entity_id if entry.entity_type == "device" else None)

    def name_of(entry: AuditLog) -> str:
        device_id = device_of(entry)
        return names.get(device_id, f"Device #{device_id}") if device_id else "—"

    connects = [e for e in entries if e.action == AuditAction.REMOTE_CONNECT
                and details[e.id].get("action") != _RS_PASSWORD_REVEAL]
    password_reveals = [e for e in entries if e.action == AuditAction.REMOTE_CONNECT
                        and details[e.id].get("action") == _RS_PASSWORD_REVEAL]
    unattributed = [e for e in entries if e.action == AuditAction.REMOTE_SESSION_STARTED
                    and details[e.id].get("attribution") != "connect_request"]
    terminals = [e for e in entries if e.action in (AuditAction.TERMINAL_SESSION_OPENED, AuditAction.SSH_SESSION_STARTED)]
    spans = session_spans(db, [*connects, *unattributed, *terminals])

    operators = Counter()
    total_seconds = 0
    remote_rows = []
    for entry in [*connects, *unattributed]:
        span = spans.get(entry.id)
        clicked = entry.action == AuditAction.REMOTE_CONNECT
        duration, outcome, tone, counted = None, "Pending", "neutral", False
        if span is not None:
            if span.no_session:
                outcome, tone = "No session", "neutral"
            elif span.live_since is not None:
                duration = max(0, int((ctx.now - ensure_utc(span.live_since)).total_seconds()))
                outcome, tone, counted = "Live", "info", True
            else:
                duration = span.duration_seconds
                outcome, tone, counted = ("Joined open session", "neutral", True) if span.joined else ("Session", "ok", True)
        if not clicked:
            outcome, tone = "No Connect click", "warn"
            counted = True
        if counted and duration and not (span and span.joined):
            total_seconds += duration
        if counted and entry.operator_username not in _SYSTEM_USERS:
            operators[entry.operator_username] += 1
        info = details[entry.id]
        remote_rows.append({
            "start": iso(entry.created_at), "operator": entry.operator_username or "—", "device": name_of(entry),
            "duration": duration, "outcome": outcome,
            "end_reason": (span.end_reason or "").replace("_", " ") or None if span else None,
            "from": safe_text(info.get("peer_name") or info.get("ip")) or None,
            "_tone": tone, "_device_id": device_of(entry), "_counted": counted,
        })

    session_ids = [details[e.id].get("session_id") for e in terminals if isinstance(details[e.id].get("session_id"), str)]
    sessions = {s.id: s for s in db.query(TerminalSession).filter(TerminalSession.id.in_(session_ids))} if session_ids else {}
    terminal_rows = []
    for entry in terminals:
        info = details[entry.id]
        session = sessions.get(info.get("session_id"))
        span = spans.get(entry.id)
        engine = (session.engine if session else None) or info.get("engine") or (
            "ssh" if entry.action == AuditAction.SSH_SESSION_STARTED else None)
        if session is not None and session.mode == "ssh":
            engine = "ssh"
        duration = None
        state = "Not started"
        if span is not None and span.live_since is not None:
            duration, state = max(0, int((ctx.now - ensure_utc(span.live_since)).total_seconds())), "Live"
        elif span is not None:
            duration, state = span.duration_seconds, span.end_reason or "closed"
        elif session is not None and session.status in ("expired", "failed"):
            state = session.status
        if duration:
            total_seconds += duration
        if entry.operator_username not in _SYSTEM_USERS:
            operators[entry.operator_username] += 1
        terminal_rows.append({
            "start": iso(entry.created_at), "operator": entry.operator_username or "—", "device": name_of(entry),
            "type": _ENGINE.get((engine or "").lower(), (engine or "Terminal").title()),
            "duration": duration, "end_reason": state.replace("_", " "),
            "recorded": "Yes" if session is not None and session.recording_path else "No",
            "_tone": "info" if state == "Live" else "neutral", "_device_id": device_of(entry),
        })

    script_rows = [{
        "time": iso(e.created_at), "operator": e.operator_username or "—", "device": name_of(e),
        "script": safe_text(details[e.id].get("name")) or "—", "version": details[e.id].get("version"),
        "_device_id": device_of(e),
    } for e in entries if e.action == AuditAction.CONSOLE_SCRIPT_RUN]

    refused = [e for e in entries if e.action == AuditAction.REMOTE_SUPPORT_ALARM]
    refused_rows = [{
        "time": iso(e.created_at), "device": name_of(e), "reason": safe_text(details[e.id].get("reason")) or "—",
        "caller": safe_text(details[e.id].get("caller")) or "—", "caller_ip": details[e.id].get("caller_ip") or None,
        "_tone": "warn", "_device_id": device_of(e),
    } for e in refused]

    reveal_rows = [{
        "time": iso(e.created_at), "operator": e.operator_username or "—",
        "credential": json_dict(e.details_json).get("name") or f"Credential #{e.entity_id}",
        "reason": safe_text(json_dict(e.details_json).get("reason")) or "—", "_tone": "info",
    } for e in reveals]
    reveal_rows += [{
        "time": iso(e.created_at), "operator": e.operator_username or "—",
        "credential": f"Remote Support login of {name_of(e)}", "reason": "—", "_tone": "info",
        "_device_id": device_of(e),
    } for e in password_reveals]
    reveal_rows.sort(key=lambda r: r["time"], reverse=True)

    remote_count = sum(1 for r in remote_rows if r.pop("_counted"))
    sessions_count = remote_count + len(terminal_rows)
    no_click = len(unattributed)
    summary = [
        ReportKpi(label="Sessions", value=sessions_count, tone="neutral",
                  hint=f"{plural(remote_count, 'Remote Support session')}, {plural(len(terminal_rows), 'terminal session')}"),
        ReportKpi(label="Session time", value=total_seconds, kind="duration", tone="neutral",
                  hint="Remote Support and terminal sessions"),
        ReportKpi(label="Operators", value=len(operators), tone="neutral",
                  hint=", ".join(name for name, _ in operators.most_common(3)) or "None"),
        ReportKpi(label="Without a Connect click", value=no_click, tone="warn" if no_click else "ok",
                  hint="Remote Support sessions not started from TECHI"),
        ReportKpi(label="Refused logins", value=len(refused_rows), tone="warn" if refused_rows else "ok",
                  hint="Remote Support refused a connection"),
    ]
    sections = [
        ReportSection(
            key="remote_support", title="Remote Support sessions",
            description="Each Connect click with the session it opened, and sessions that started without one.",
            columns=[col("start", "Start", "datetime"), col("operator", "Operator"), col("device", "Device"),
                     col("duration", "Duration", "duration"), col("outcome", "Outcome", "badge"), col("end_reason", "Ended"),
                     col("from", "From")],
            rows=remote_rows, empty="No Remote Support sessions in the period.",
            note="No Connect click: someone connected with the device's ID and password outside TECHI. "
                 "Joined open session: a second operator joined a session already running (its time is counted once).",
        ),
        ReportSection(
            key="terminal", title="PowerShell, terminal and SSH sessions",
            columns=[col("start", "Start", "datetime"), col("operator", "Operator"), col("device", "Device"),
                     col("type", "Type", "badge"), col("duration", "Duration", "duration"), col("end_reason", "Ended"),
                     col("recorded", "Recorded", "badge")],
            rows=terminal_rows, empty="No terminal sessions in the period.",
        ),
        ReportSection(
            key="scripts", title="Saved scripts run",
            columns=[col("time", "Time", "datetime"), col("operator", "Operator"), col("device", "Device"),
                     col("script", "Script"), col("version", "Version", "number")],
            rows=script_rows, empty="No saved scripts were run.",
        ),
        ReportSection(
            key="refused", title="Refused Remote Support logins",
            description="Connections Remote Support refused (wrong password, not allowed).",
            columns=[col("time", "Time", "datetime"), col("device", "Device"), col("reason", "Reason"),
                     col("caller", "Caller"), col("caller_ip", "Caller IP")],
            rows=refused_rows, empty="No refused logins.",
        ),
        ReportSection(
            key="reveals", title="Revealed logins",
            description="Vault entries of this client and Remote Support logins an operator displayed in clear text.",
            columns=[col("time", "Time", "datetime"), col("operator", "Operator"), col("credential", "Entry"),
                     col("reason", "Reason given")],
            rows=reveal_rows, empty="Nothing was revealed.",
        ),
    ]
    notes = ["Times of Remote Support sessions come from TECHI Remote Support's own connection reports where available."]
    if truncated:
        notes.append(f"Only the latest {MAX_ENTRIES} audit entries of the period were read.")
    document = ctx.document(key=KEY, title="Access audit", subtitle=None, summary=summary, sections=sections, notes=notes)

    issues, recs = [], []
    if no_click:
        issues.append(Issue(WARN, f"{plural(no_click, 'Remote Support session')} started without a Connect click", KEY, no_click))
        recs.append(Recommendation(70, f"Review the {plural(no_click, 'Remote Support session')} that started without a Connect "
                                       "click in TECHI: someone used the device's ID and password directly."))
    if refused_rows:
        top = Counter(r["caller"] for r in refused_rows if r["caller"] != "—").most_common(1)
        issues.append(Issue(WARN if len(refused_rows) >= 5 else INFO, f"{plural(len(refused_rows), 'refused Remote Support login')}", KEY, len(refused_rows)))
        if len(refused_rows) >= 5:
            caller = f" (most from {top[0][0]})" if top else ""
            recs.append(Recommendation(60, f"Check the {plural(len(refused_rows), 'refused Remote Support login')}{caller}; "
                                           "rotate the device's Remote Support password if they were not your staff."))
    facts = {"sessions": sessions_count, "seconds": total_seconds, "operators": len(operators), "no_click": no_click,
             "refused": len(refused_rows), "time_label": human_duration(total_seconds)}
    return Built(document, issues, recs, facts)
