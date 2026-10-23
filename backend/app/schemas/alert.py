from datetime import date, datetime
from typing import Any, Dict, List, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field


class AlertOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    device_id: Optional[int] = None
    token_id: Optional[int] = None
    kind: str
    severity: str
    state: str
    message: str
    detail: Optional[str] = None
    created_at: datetime
    updated_at: datetime
    resolved_at: Optional[datetime] = None
    acknowledged_at: Optional[datetime] = None
    cooldown_until: Optional[datetime] = None
    # The device's current name and client, so a list never fetches each
    # device separately and never shows the hostname frozen into `message`.
    device_name: Optional[str] = None
    client_name: Optional[str] = None
    client_id: Optional[int] = None
    # The work queue.
    fingerprint: str = ""
    occurrences: int = 1
    last_seen_at: Optional[datetime] = None
    priority: Optional[int] = None
    assigned_to_id: Optional[int] = None
    assigned_to_name: Optional[str] = None
    snoozed_until: Optional[datetime] = None
    snooze_until_worse: bool = False
    resolution: Optional[str] = None
    resolved_by: Optional[str] = None
    # Plain words (app/services/alert_presenter.py).
    title: Optional[str] = None
    summary: Optional[str] = None
    value: Optional[str] = None
    device_role: Optional[str] = None  # "server" | "pc"
    # Synthetic site outage: the devices it groups.
    member_ids: Optional[List[int]] = None
    # Deadlines (app/services/alert_sla.py).
    ack_due_at: Optional[datetime] = None
    resolve_due_at: Optional[datetime] = None
    sla_24x7: bool = False
    sla_step: int = 0
    sla_state: Optional[str] = None  # ack_overdue | overdue | waiting
    first_action_at: Optional[datetime] = None
    waiting_reason: Optional[str] = None
    waiting_since: Optional[datetime] = None
    # Incidents: the lead this alert follows, or how many follow it.
    parent_id: Optional[int] = None
    followers: int = 0
    recurring: bool = False


class AlertPage(BaseModel):
    items: List[AlertOut]
    total: int


class AlertCountResponse(BaseModel):
    total_open: int
    by_severity: Dict[str, int]
    by_kind: Dict[str, int] = {}
    devices_affected: int = 0
    oldest_open_at: Optional[datetime] = None
    views: Dict[str, int] = {}
    by_priority: Dict[str, int] = {}


class AlertGroupOut(BaseModel):
    key: str
    label: Optional[str] = None
    title: Optional[str] = None
    kind: Optional[str] = None
    fingerprint: str = ""
    client_id: Optional[int] = None
    device_id: Optional[int] = None
    count: int
    devices: int
    priority: int
    critical: int = 0
    latest: Optional[datetime] = None


class AlertActivityOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    at: datetime
    actor: Optional[str] = None
    action: str
    detail: Optional[str] = None


class RunbookCommandOut(BaseModel):
    label: str
    script: str
    risk: str


class RunbookOut(BaseModel):
    key: str
    why: str
    steps: List[str]
    commands: List[RunbookCommandOut] = []
    escalate: Optional[str] = None


class AlertAnalysisOut(BaseModel):
    id: int
    alert_id: Optional[int] = None
    group_key: Optional[str] = None
    language: str
    model: str
    created_at: datetime
    created_by: Optional[str] = None
    result: Optional[Dict[str, Any]] = None
    error: Optional[str] = None
    input_tokens: Optional[int] = None
    output_tokens: Optional[int] = None
    cost_usd: Optional[float] = None
    rating: Optional[int] = None
    cached: bool = False
    stale: bool = False


class AlertDetailOut(BaseModel):
    alert: AlertOut
    description: str
    facts: Dict[str, Any] = {}
    evidence: Dict[str, Any] = {}
    history: List[datetime] = []
    activity: List[AlertActivityOut] = []
    runbook: Optional[RunbookOut] = None
    analysis: Optional[AlertAnalysisOut] = None
    ai_enabled: bool = False
    # {lead_id, lead_device, followers: [{id, device_id, device_name}]}
    incident: Optional[Dict[str, Any]] = None


Resolution = Literal["fixed", "false_positive", "expected", "duplicate"]


class AlertResolveBody(BaseModel):
    resolution: Resolution = "fixed"
    note: Optional[str] = Field(default=None, max_length=1000)


class AlertSnoozeBody(BaseModel):
    minutes: Optional[int] = Field(default=None, ge=5, le=60 * 24 * 30)
    until: Optional[datetime] = None
    until_worse: bool = False


class AlertAssignBody(BaseModel):
    operator_id: Optional[int] = None


class AlertNoteBody(BaseModel):
    text: str = Field(min_length=1, max_length=1000)


WaitingReason = Literal["client", "vendor", "parts", "maintenance"]


class AlertWaitBody(BaseModel):
    reason: WaitingReason
    note: Optional[str] = Field(default=None, max_length=1000)


class AlertBulkBody(BaseModel):
    ids: List[int] = Field(min_length=1, max_length=500)
    action: Literal["take", "assign", "snooze", "unsnooze", "resolve", "wait", "resume"]
    reason: Optional[WaitingReason] = None
    operator_id: Optional[int] = None
    minutes: Optional[int] = Field(default=None, ge=5, le=60 * 24 * 30)
    until_worse: bool = False
    resolution: Resolution = "fixed"
    note: Optional[str] = Field(default=None, max_length=1000)


class AlertBulkResult(BaseModel):
    done: List[int]
    failed: List[int]


class AlertMuteBody(BaseModel):
    device_id: Optional[int] = None
    client_id: Optional[int] = None
    kind: Optional[str] = Field(default=None, max_length=64)
    fingerprint: Optional[str] = Field(default=None, max_length=128)
    days: Optional[int] = Field(default=None, ge=1, le=365)  # None: until removed
    reason: str = Field(min_length=3, max_length=500)
    resolve_open: bool = True


class AlertMuteOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    device_id: Optional[int] = None
    device_name: Optional[str] = None
    client_id: Optional[int] = None
    client_name: Optional[str] = None
    kind: Optional[str] = None
    fingerprint: Optional[str] = None
    until: Optional[datetime] = None
    reason: str
    created_by: Optional[str] = None
    created_at: datetime
    closed: int = 0


class AlertAnalyzeBody(BaseModel):
    language: Optional[Literal["sq", "en"]] = None
    force: bool = False


class AlertGroupAnalyzeBody(AlertAnalyzeBody):
    issue: str = Field(min_length=1, max_length=200)


class AlertRateBody(BaseModel):
    rating: Literal[1, -1]


class FindingOut(BaseModel):
    device_id: int
    device_name: str
    client_name: Optional[str] = None
    device_role: str
    type: str  # security | reboot | power | disk_forecast
    severity: str  # high | medium | low
    title: str
    detail: Optional[str] = None
    since: Optional[datetime] = None


class FindingsPage(BaseModel):
    items: List[FindingOut]
    counts: Dict[str, int]


class QualityRow(BaseModel):
    issue: str
    title: str
    opened: int
    reopened: int
    devices: int
    flapping: int  # closed by itself within 15 min
    false_positive: int
    expected: int
    still_open: int
    mtta_minutes: Optional[float] = None
    mttr_minutes: Optional[float] = None
    noise_pct: float


class DeadlinePriorityRow(BaseModel):
    priority: int
    alerts: int
    owned_pct: Optional[float] = None
    mtta_minutes: Optional[float] = None  # clock minutes: working hours, or every hour for a P1 on a server
    mttr_minutes: Optional[float] = None
    ack_met_pct: Optional[float] = None
    met_pct: Optional[float] = None
    overdue_open: int = 0


class DeadlinePersonRow(BaseModel):
    name: str
    resolved: int
    mttr_minutes: Optional[float] = None
    met_pct: Optional[float] = None


class DeadlineReport(BaseModel):
    by_priority: List[DeadlinePriorityRow] = []
    by_person: List[DeadlinePersonRow] = []
    urgent_owned_pct: Optional[float] = None
    fixed: int = 0
    fix_failed: int = 0
    fix_failed_pct: Optional[float] = None


class QualityReport(BaseModel):
    days: int
    since: datetime
    rows: List[QualityRow]
    totals: Dict[str, Any]
    deadlines: Optional[DeadlineReport] = None


class DutyShiftBody(BaseModel):
    starts_on: date
    ends_on: date
    operator_id: int
    backup_operator_id: Optional[int] = None
    note: Optional[str] = Field(default=None, max_length=200)


class DutyShiftOut(BaseModel):
    id: int
    starts_on: date
    ends_on: date
    operator_id: int
    operator_name: Optional[str] = None
    backup_operator_id: Optional[int] = None
    backup_name: Optional[str] = None
    note: Optional[str] = None
    created_by: Optional[str] = None


class DeadlineRule(BaseModel):
    priority: int
    ack_minutes: Optional[int] = None
    resolve_minutes: int
    round_the_clock_on_servers: bool = False


class DutyOut(BaseModel):
    today: date
    current: Optional[DutyShiftOut] = None
    shifts: List[DutyShiftOut] = []
    deadlines: List[DeadlineRule] = []
    work_hours: Dict[str, Any] = {}


class HandoverItem(BaseModel):
    id: int
    priority: int
    title: str
    device_name: str
    client_name: Optional[str] = None
    owner: Optional[str] = None
    ack_due_at: Optional[datetime] = None
    resolve_due_at: Optional[datetime] = None
    sla_state: Optional[str] = None
    waiting_reason: Optional[str] = None
    last_note: Optional[str] = None


class AlertOperatorOut(BaseModel):
    id: int
    name: str
