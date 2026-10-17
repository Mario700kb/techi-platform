"""How long the sessions in an activity page lasted.

The audit log records a session's start and its end as two entries; the end
carries the duration. An operator reading the log wants it next to the start
— "Remote connect … 18 min", "PowerShell opened … 55 s" — or "live" while the
session is still open. This links, for one page of entries:

- terminal_session_opened → the terminal session (PowerShell, bash, SSH);
- remote_session_started  → the remote_session_ended of that device that
  carries the same start time;
- remote_connect          → the Remote Support session that click started
  (remote_session_started records the click it was attributed to).
"""
import json
from datetime import datetime, timedelta
from typing import Dict, Iterable, List, Optional

from sqlalchemy.orm import Session

from app.core.time import ensure_utc, utcnow
from app.models.audit_log import AuditLog
from app.models.device import Device
from app.models.terminal_session import TerminalSession, TerminalSessionStatus
from app.schemas.client import SessionSpan
from app.services.audit_service import AuditAction

# remote_session_started is written moments after the start it records.
_SAME_START = timedelta(seconds=10)
# A Remote Support session longer than this is not looked for.
_LONGEST = timedelta(days=2)


def _details(entry: AuditLog) -> dict:
    try:
        value = json.loads(entry.details_json or "{}")
        return value if isinstance(value, dict) else {}
    except ValueError:
        return {}


def _iso(value) -> Optional[datetime]:
    if not isinstance(value, str):
        return None
    try:
        return ensure_utc(datetime.fromisoformat(value))
    except ValueError:
        return None


def _device_of(entry: AuditLog) -> Optional[int]:
    if entry.device_id:
        return entry.device_id
    if entry.entity_type == "device" and entry.entity_id:
        return entry.entity_id
    return None


def session_spans(db: Session, items: Iterable[AuditLog]) -> Dict[int, SessionSpan]:
    items = list(items)
    spans: Dict[int, SessionSpan] = {}

    # ── terminal sessions ───────────────────────────────────────────────────
    opened = {e.id: _details(e).get("session_id") for e in items if e.action == AuditAction.TERMINAL_SESSION_OPENED}
    session_ids = [sid for sid in opened.values() if isinstance(sid, str)]
    if session_ids:
        sessions = {s.id: s for s in db.query(TerminalSession).filter(TerminalSession.id.in_(session_ids))}
        live = {TerminalSessionStatus.PENDING.value, TerminalSessionStatus.ACTIVE.value}
        for entry_id, sid in opened.items():
            session = sessions.get(sid)
            if session is None:
                continue
            if session.status in live:
                spans[entry_id] = SessionSpan(live_since=ensure_utc(session.started_at or session.created_at))
            elif session.started_at and session.ended_at:
                spans[entry_id] = SessionSpan(duration_seconds=session.duration_seconds,
                                              end_reason=session.disconnect_reason)

    # ── Remote Support sessions ─────────────────────────────────────────────
    remote = [e for e in items if e.action in (AuditAction.REMOTE_SESSION_STARTED, AuditAction.REMOTE_CONNECT)]
    devices = {d for d in (_device_of(e) for e in remote) if d}
    if not devices:
        return spans
    since = min(ensure_utc(e.created_at) for e in remote) - _SAME_START
    until = max(ensure_utc(e.created_at) for e in remote) + _LONGEST
    rows: List[AuditLog] = (
        db.query(AuditLog)
        .filter(
            AuditLog.action.in_([AuditAction.REMOTE_SESSION_STARTED, AuditAction.REMOTE_SESSION_ENDED]),
            AuditLog.entity_type == "device",
            AuditLog.entity_id.in_(list(devices)),
            AuditLog.created_at >= since.replace(tzinfo=None),
            AuditLog.created_at <= until.replace(tzinfo=None),
        )
        .order_by(AuditLog.created_at)
        .all()
    )
    starts = [r for r in rows if r.action == AuditAction.REMOTE_SESSION_STARTED]
    ends = [r for r in rows if r.action == AuditAction.REMOTE_SESSION_ENDED]
    open_since = {
        d.id: ensure_utc(d.rustdesk_session_started_at)
        for d in db.query(Device).filter(Device.id.in_(list(devices)))
        if d.rustdesk_session_active and d.rustdesk_session_started_at
    }

    def span_of_start(start: AuditLog) -> Optional[SessionSpan]:
        device = _device_of(start)
        at = ensure_utc(start.created_at)
        for end in ends:
            if end.entity_id != device:
                continue
            details = _details(end)
            began = _iso(details.get("started_at"))
            if began is not None and abs(began - at) <= _SAME_START:
                minutes = details.get("duration_minutes")
                seconds = int((ensure_utc(end.created_at) - began).total_seconds())
                if isinstance(minutes, (int, float)) and seconds <= 0:
                    seconds = int(minutes * 60)
                return SessionSpan(duration_seconds=max(0, seconds), end_reason=details.get("reason"))
        began = open_since.get(device)
        if began is not None and abs(began - at) <= _SAME_START and utcnow() - began < _LONGEST:
            return SessionSpan(live_since=began)
        return None

    for entry in remote:
        if entry.action == AuditAction.REMOTE_SESSION_STARTED:
            span = span_of_start(entry)
        else:
            # The session this Connect click started, if one was attributed to it.
            clicked = ensure_utc(entry.created_at)
            start = next(
                (s for s in starts
                 if s.entity_id == _device_of(entry)
                 and (requested := _iso(_details(s).get("connect_requested_at"))) is not None
                 and abs(requested - clicked) <= timedelta(seconds=1)),
                None,
            )
            span = span_of_start(start) if start is not None else None
        if span is not None:
            spans[entry.id] = span
    return spans
