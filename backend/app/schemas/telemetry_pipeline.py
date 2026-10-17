"""Shapes for the telemetry pipeline: what an agent uploads, what it is told to
collect, and what the pages read back."""
from datetime import datetime
from typing import List, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field

# ── agent → platform ────────────────────────────────────────────────────────

MAX_SAMPLES_PER_UPLOAD = 2000


class UploadDisk(BaseModel):
    model_config = ConfigDict(extra="ignore")

    mount: str = Field(max_length=64)
    used_pct: float = Field(ge=0, le=100)
    free_gb: Optional[float] = Field(default=None, ge=0)
    total_gb: Optional[float] = Field(default=None, ge=0)


class UploadSample(BaseModel):
    model_config = ConfigDict(extra="ignore")

    seq: int = Field(ge=1)
    ts: datetime  # UTC
    cpu: Optional[float] = Field(default=None, ge=0, le=100)
    mem: Optional[float] = Field(default=None, ge=0, le=100)
    mem_used_mb: Optional[float] = Field(default=None, ge=0)
    net_rx_bps: Optional[float] = Field(default=None, ge=0)
    net_tx_bps: Optional[float] = Field(default=None, ge=0)
    uptime_s: Optional[int] = Field(default=None, ge=0)
    disks: List[UploadDisk] = Field(default_factory=list, max_length=26)


class MonitorEvent(BaseModel):
    """A monitor changed state on the device. Sent live over the command
    channel; also carried in the next upload, so one lost on the way is still
    applied (applying the same state twice changes nothing)."""

    model_config = ConfigDict(extra="ignore")

    key: str = Field(max_length=32)
    state: Literal["firing", "ok"]
    value: Optional[float] = None
    threshold: Optional[float] = None
    since: Optional[datetime] = None
    target: Optional[str] = Field(default=None, max_length=64)  # e.g. the disk


class BufferReport(BaseModel):
    model_config = ConfigDict(extra="ignore")

    pending: int = Field(default=0, ge=0)
    oldest_pending: Optional[datetime] = None
    dropped_total: int = Field(default=0, ge=0)


class TelemetryUpload(BaseModel):
    model_config = ConfigDict(extra="ignore")

    schema_version: int = Field(default=1, alias="schema", ge=1, le=10)
    device_id: int
    agent_id: str = Field(max_length=128)
    agent_time: Optional[datetime] = None
    sample_seconds: Optional[int] = Field(default=None, ge=10, le=3600)
    policy_version: Optional[str] = Field(default=None, max_length=64)
    samples: List[UploadSample] = Field(default_factory=list, max_length=MAX_SAMPLES_PER_UPLOAD)
    events: List[MonitorEvent] = Field(default_factory=list, max_length=200)
    buffer: BufferReport = Field(default_factory=BufferReport)


class TelemetryAck(BaseModel):
    ack_seq: int
    stored: int
    duplicates: int
    rejected: int
    policy_version: str
    next_upload_seconds: int


# ── policies ────────────────────────────────────────────────────────────────

Metric = Literal["cpu", "mem", "disk", "net_rx_mbps", "net_tx_mbps", "disk_forecast_days", "no_data"]
Severity = Literal["info", "warning", "critical"]


class Monitor(BaseModel):
    model_config = ConfigDict(extra="ignore")

    key: str = Field(min_length=1, max_length=32, pattern=r"^[a-z0-9_]+$")
    metric: Metric
    op: Literal[">", "<"] = ">"
    threshold: float = Field(ge=0, le=100000)
    duration_s: int = Field(default=0, ge=0, le=86400)
    severity: Severity = "warning"
    enabled: bool = True


class PolicyBody(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    description: Optional[str] = Field(default=None, max_length=2000)
    scope: Literal["default", "device_type", "client", "group"]
    scope_value: Optional[str] = Field(default=None, max_length=64)
    enabled: bool = True
    sample_seconds: int = Field(default=60, ge=30, le=900)
    upload_seconds: int = Field(default=900, ge=60, le=3600)
    buffer_mb: int = Field(default=50, ge=5, le=500)
    keep_days: int = Field(default=7, ge=1, le=30)
    monitors: List[Monitor] = Field(default_factory=list, max_length=40)


class PolicyOut(PolicyBody):
    id: int
    version: int
    updated_at: datetime
    updated_by: Optional[str] = None
    devices: int = 0
    devices_current: int = 0


class EffectivePolicy(BaseModel):
    """What one device collects: the most specific policy's settings, with the
    monitors of broader policies it does not override."""

    version: str
    sample_seconds: int
    upload_seconds: int
    buffer_mb: int
    keep_days: int
    monitors: List[Monitor]
    policies: List[str]


# ── pages ───────────────────────────────────────────────────────────────────

Range = Literal["1h", "24h", "7d", "30d", "13mo"]


class MetricPoint(BaseModel):
    t: datetime
    samples: int
    expected: int
    cpu_avg: Optional[float] = None
    cpu_max: Optional[float] = None
    mem_avg: Optional[float] = None
    mem_max: Optional[float] = None
    rx_avg: Optional[float] = None
    rx_max: Optional[float] = None
    tx_avg: Optional[float] = None
    tx_max: Optional[float] = None
    disk_max: Optional[float] = None


class DiskTrend(BaseModel):
    mount: str
    used_pct: float
    free_gb: Optional[float] = None
    total_gb: Optional[float] = None
    growth_gb_per_day: Optional[float] = None
    days_to_90: Optional[float] = None
    days_to_full: Optional[float] = None
    history: List[float] = Field(default_factory=list)  # daily used %, oldest first


class CoverageSegment(BaseModel):
    start: datetime
    end: datetime
    kind: Literal["received", "late", "missing", "off"]


class Coverage(BaseModel):
    received: int
    late: int
    missing_minutes: int
    off_minutes: int
    pct: Optional[float]  # received / (received + missing), device-off time excluded
    segments: List[CoverageSegment] = Field(default_factory=list)


class MetricSummary(BaseModel):
    cpu_avg: Optional[float] = None
    cpu_p95: Optional[float] = None
    cpu_peak: Optional[float] = None
    cpu_peak_at: Optional[datetime] = None
    mem_avg: Optional[float] = None
    mem_peak: Optional[float] = None
    rx_peak: Optional[float] = None
    tx_peak: Optional[float] = None


class DeliveryState(BaseModel):
    last_upload_at: Optional[datetime] = None
    last_sample_at: Optional[datetime] = None
    pending: int = 0
    oldest_pending_at: Optional[datetime] = None
    dropped_total: int = 0
    clock_offset_ms: Optional[int] = None
    sample_seconds: Optional[int] = None
    policy_version: Optional[str] = None
    policy_current: bool = False


class DeviceMetrics(BaseModel):
    range: Range
    resolution: Literal["1m", "5m", "1h", "1d"]
    source: Literal["agent", "heartbeat", "none"]
    start: datetime
    end: datetime
    points: List[MetricPoint]
    summary: MetricSummary
    disks: List[DiskTrend]
    coverage: Coverage
    delivery: Optional[DeliveryState] = None
    policy: EffectivePolicy


class MonitorStatus(BaseModel):
    key: str
    metric: str
    rule: str
    severity: str
    enabled: bool
    state: Literal["ok", "firing", "watch", "unknown"]
    now: Optional[str] = None
    alert_id: Optional[int] = None


class DeviceMonitoring(BaseModel):
    policy: EffectivePolicy
    monitors: List[MonitorStatus]
    delivery: Optional[DeliveryState] = None


class HeatmapRow(BaseModel):
    device_id: int
    name: str
    cells: List[Optional[float]]  # 24 hour-of-day averages; None = off/no data
    peak: Optional[float] = None


class AttentionItem(BaseModel):
    device_id: int
    name: str
    kind: Literal["disk_forecast", "cpu_sustained", "mem_sustained", "not_seen", "gaps", "monitor"]
    severity: Severity
    title: str
    detail: str


class ClientDeviceRow(BaseModel):
    device_id: int
    name: str
    kind: str
    agent_version: Optional[str] = None
    spark: List[Optional[float]]
    cpu_peak: Optional[float] = None
    mem_peak: Optional[float] = None
    disk_worst: Optional[str] = None
    disk_worst_pct: Optional[float] = None
    coverage_pct: Optional[float] = None
    one_minute: bool = False
    monitors_firing: int = 0


class TrendPoint(BaseModel):
    t: datetime
    cpu_avg: Optional[float] = None
    cpu_p95: Optional[float] = None
    mem_avg: Optional[float] = None


class ClientMonitoring(BaseModel):
    range: Range
    devices_total: int
    devices_reporting: int
    one_minute_devices: int
    coverage_pct: Optional[float]
    coverage_breakdown: Coverage
    monitor_alerts: int
    monitor_alerts_open: int
    cpu_avg: Optional[float]
    busiest_hour: Optional[int]
    busiest_hour_cpu: Optional[float]
    disks_at_risk: int
    heatmap: List[HeatmapRow]
    trend: List[TrendPoint]
    attention: List[AttentionItem]
    devices: List[ClientDeviceRow]


class StorageTier(BaseModel):
    name: str
    keep: str
    bytes: Optional[int] = None
    rows: Optional[int] = None


class PipelineHealth(BaseModel):
    devices_online: int
    devices_one_minute: int
    uploads_last_hour: int
    median_delay_seconds: Optional[float]
    devices_with_backlog: int
    oldest_backlog_at: Optional[datetime]
    dropped_30d: int
    samples_30d: int
    policy_behind: int
    storage: List[StorageTier]
