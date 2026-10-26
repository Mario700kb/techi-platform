"""Reads the telemetry pipeline for the pages: a device's charts, coverage and
disk forecasts, a client's analytics, and the health of the pipeline itself.

Resolution follows the range so a chart never carries more than ~1,500
points: 1 h and 24 h read the raw minutes, 7 days the 5-minute rollup, 30 days
the hourly one, 13 months hourly folded into days. A device whose agent does
not upload yet (before 2.1.29) is read from its 5-minute heartbeat telemetry
instead, so every device has a chart; those keep 7 days.
"""
import math
from collections import defaultdict
from datetime import datetime, timedelta
from statistics import median
from typing import Dict, List, Optional, Sequence, Tuple
from zoneinfo import ZoneInfo

from sqlalchemy import func, text
from sqlalchemy.orm import Session

from app.platform_core.classification import classify_category
from app.core.time import utcnow_naive
from app.models.alert import AlertState, DeviceAlert
from app.models.device import Device, DeviceStatus
from app.models.device_telemetry import DeviceTelemetry
from app.models.telemetry_pipeline import (
    DeviceTelemetryState,
    TelemetryRollup1h,
    TelemetryRollup5m,
    TelemetrySample,
)
from app.schemas.telemetry_pipeline import (
    AlertSpan,
    AttentionItem,
    ClientDeviceRow,
    ClientMonitoring,
    Coverage,
    CoverageSegment,
    DeliveryState,
    DeviceMetrics,
    DeviceMonitoring,
    DiskTrend,
    HealthEventView,
    HealthView,
    HeatmapRow,
    MetricPoint,
    MetricSummary,
    MonitorStatus,
    PhysicalDiskView,
    PipelineHealth,
    ProcessPeak,
    StorageTier,
    TrendPoint,
)
from app.schemas.device_health import REBOOT_REASONS
from app.services.agent_command_service import _parse_agent_version
from app.services.device_health import alerting_events, disks_with_problems, reboot_pending_days
from app.services.device_inventory_service import DeviceInventoryService
from app.services.monitor_alert_service import AGENT_METRICS_SINCE, METRIC_KIND, describe
from app.services.monitoring_policy_service import effective_policy
from app.services.security_posture import posture_score
from app.services.telemetry_ingest_service import SMALL_VOLUME_GB, monitored_disks

LOCAL_TZ = ZoneInfo("Europe/Tirane")
RANGES = {
    "1h": timedelta(hours=1), "24h": timedelta(hours=24), "7d": timedelta(days=7),
    "30d": timedelta(days=30), "13mo": timedelta(days=395),
}
SOURCE_LATE = 3
# A boot is a new one when the uptime puts it this far from the last.
BOOT_JITTER = timedelta(minutes=3)
MAX_ALERT_SPANS = 60
MAX_PROCESSES = 8
# Average and peak columns a point carries from the 2.1.33 samples.
_EXTRA_POINT = {
    "disk_busy": ("disk_busy_avg", "disk_busy_max"),
    "disk_queue": ("disk_queue_avg", None),
    "disk_read_bps": ("disk_read_avg", None),
    "disk_write_bps": ("disk_write_avg", None),
    "gw_ms": ("gw_ms_avg", "gw_ms_max"),
    "gw_loss": ("gw_loss_avg", "gw_loss_max"),
    "wan_ms": ("wan_ms_avg", None),
}
# Point field → rollup column, where the names differ.
_ROLLUP_COLUMN = {
    "disk_busy_avg": "disk_busy_avg", "disk_busy_max": "disk_busy_max", "disk_queue_avg": "disk_queue_avg",
    "disk_read_avg": "disk_read_avg", "disk_write_avg": "disk_write_avg", "gw_ms_avg": "gw_ms_avg",
    "gw_ms_max": "gw_ms_max", "gw_loss_avg": "gw_loss_avg", "gw_loss_max": "gw_loss_max", "wan_ms_avg": "wan_ms_avg",
}
_AVG_FIELDS = ("disk_busy_avg", "disk_queue_avg", "disk_read_avg", "disk_write_avg", "gw_ms_avg", "gw_loss_avg", "wan_ms_avg")
_MAX_FIELDS = ("disk_busy_max", "gw_ms_max", "gw_loss_max")


def _pct(values: Sequence[float], q: float) -> Optional[float]:
    if not values:
        return None
    ordered = sorted(values)
    k = (len(ordered) - 1) * q
    lo, hi = math.floor(k), math.ceil(k)
    return round(ordered[lo] + (ordered[hi] - ordered[lo]) * (k - lo), 1)


def _avg(values: Sequence[float]) -> Optional[float]:
    return round(sum(values) / len(values), 1) if values else None


def _local_hour(ts: datetime) -> int:
    return ts.replace(tzinfo=ZoneInfo("UTC")).astimezone(LOCAL_TZ).hour


# ── per-device pieces ───────────────────────────────────────────────────────

def disk_trends(db: Session, device_id: int, days: int = 30) -> List[DiskTrend]:
    """Each fixed disk now and its daily trend; growth fitted over the last
    14 days gives the days left to 90% and to full."""
    since = utcnow_naive() - timedelta(days=days)
    rows = (
        db.query(TelemetryRollup1h.bucket, TelemetryRollup1h.disks)
        .filter(TelemetryRollup1h.device_id == device_id, TelemetryRollup1h.bucket >= since,
                TelemetryRollup1h.disks.isnot(None))
        .order_by(TelemetryRollup1h.bucket)
        .all()
    )
    latest = (
        db.query(TelemetrySample.disks)
        .filter(TelemetrySample.device_id == device_id, TelemetrySample.disks.isnot(None))
        .order_by(TelemetrySample.ts.desc())
        .first()
    )
    current = list(latest[0]) if latest and latest[0] else (list(rows[-1][1]) if rows else [])
    daily: Dict[str, Dict] = defaultdict(dict)
    for bucket, disks in rows:
        for disk in disks or []:
            daily[disk["mount"]][bucket.date()] = disk
    out = []
    for disk in current:
        mount = disk.get("mount")
        series = sorted(daily.get(mount, {}).items())
        history = [round(d.get("used_pct", 0), 1) for _, d in series]
        growth_pct = None
        recent = [(i, v) for i, v in enumerate(history)][-14:]
        if len(recent) >= 5:
            n = len(recent)
            mx = sum(i for i, _ in recent) / n
            my = sum(v for _, v in recent) / n
            den = sum((i - mx) ** 2 for i, _ in recent)
            growth_pct = sum((i - mx) * (v - my) for i, v in recent) / den if den else 0.0
        used = float(disk.get("used_pct") or 0)
        total = disk.get("total_gb")
        days_to_90 = days_to_full = None
        if growth_pct and growth_pct > 0.05:
            days_to_90 = round((90 - used) / growth_pct, 1) if used < 90 else 0.0
            days_to_full = round((100 - used) / growth_pct, 1)
        out.append(DiskTrend(
            mount=mount, used_pct=round(used, 1), free_gb=disk.get("free_gb"), total_gb=total,
            growth_gb_per_day=round(growth_pct * total / 100, 2) if growth_pct is not None and total else None,
            days_to_90=days_to_90, days_to_full=days_to_full, history=history,
            monitored=total is None or total >= SMALL_VOLUME_GB,
        ))
    return out


def _delivery(db: Session, device: Device, policy_version: str) -> Optional[DeliveryState]:
    state = db.get(DeviceTelemetryState, device.id)
    if state is None:
        return None
    return DeliveryState(
        last_upload_at=state.last_upload_at, last_sample_at=state.last_sample_at, pending=state.pending,
        oldest_pending_at=state.oldest_pending_at, dropped_total=state.dropped_total,
        clock_offset_ms=state.clock_offset_ms, sample_seconds=state.sample_seconds,
        policy_version=state.policy_version, policy_current=state.policy_version == policy_version,
    )


def _coverage_from_samples(samples: List[Tuple[datetime, Optional[int], int]], start: datetime, end: datetime,
                           step: int) -> Coverage:
    """Walks the minute samples: a gap is "off" when the next sample's uptime
    shows the device booted during it, "missing" otherwise."""
    segments: List[CoverageSegment] = []
    received = late = missing = off = 0
    gap_limit = timedelta(seconds=step * 2)

    def push(seg_start: datetime, seg_end: datetime, kind: str) -> None:
        if segments and segments[-1].kind == kind and segments[-1].end >= seg_start - gap_limit:
            segments[-1].end = seg_end
        else:
            segments.append(CoverageSegment(start=seg_start, end=seg_end, kind=kind))

    prev: Optional[datetime] = None
    for ts, uptime, source in samples:
        if prev is not None and ts - prev > gap_limit:
            gap = ts - prev
            booted = uptime is not None and uptime < gap.total_seconds() + 120
            # The previous sample covers its own step; the hole starts after it.
            minutes = int((gap.total_seconds() - step) // 60)
            if booted:
                off += minutes
            else:
                missing += minutes
            push(prev + timedelta(seconds=step), ts, "off" if booted else "missing")
        kind = "late" if source == SOURCE_LATE else "received"
        received += 1
        late += 1 if kind == "late" else 0
        push(ts, ts + timedelta(seconds=step), kind)
        prev = ts
    total = received + missing * 60 // max(step, 1)
    return Coverage(
        received=received, late=late, missing_minutes=missing, off_minutes=off,
        pct=round(received / total * 100, 2) if total else None, segments=segments[-400:],
    )


def _restarts(samples: List[Tuple[datetime, Optional[int], int]], start: datetime) -> List[datetime]:
    """Boot times inside the range, read from each sample's uptime."""
    boots: List[datetime] = []
    for ts, uptime, _ in samples:
        if uptime is None:
            continue
        boot = (ts - timedelta(seconds=uptime)).replace(microsecond=0)
        if boots and abs(boot - boots[-1]) <= BOOT_JITTER:
            continue
        if any(abs(boot - b) <= BOOT_JITTER for b in boots):
            continue
        boots.append(boot)
    return [b for b in boots if b >= start]


def _process_peaks(points: List[MetricPoint]) -> List[ProcessPeak]:
    """The processes that were among the busiest, most often first."""
    seen: Dict[str, dict] = {}
    for point in points:
        for proc in point.top or []:
            entry = seen.setdefault(proc.n.lower(), {"name": proc.n, "minutes": 0, "cpu": None, "at": None, "mem": None})
            entry["minutes"] += max(1, point.samples)
            if proc.c is not None and (entry["cpu"] is None or proc.c > entry["cpu"]):
                entry["cpu"], entry["at"] = proc.c, point.t
            if proc.m is not None and (entry["mem"] is None or proc.m > entry["mem"]):
                entry["mem"] = proc.m
    ranked = sorted(seen.values(), key=lambda e: (-(e["cpu"] or 0) * e["minutes"], -(e["mem"] or 0)))
    return [ProcessPeak(name=e["name"], minutes=e["minutes"], cpu_peak=round(e["cpu"], 1) if e["cpu"] is not None else None,
                        cpu_peak_at=e["at"], mem_peak_mb=round(e["mem"]) if e["mem"] is not None else None)
            for e in ranked[:MAX_PROCESSES]]


def _health_view(health) -> HealthView:
    return HealthView(
        collected_at=health.collected_at,
        disks=[PhysicalDiskView(**d.model_dump(), problem=d.problem) for d in health.disks],
        reboot_pending=health.reboot_pending,
        reboot_reasons=[REBOOT_REASONS.get(r, r) for r in health.reboot_reasons],
        reboot_pending_since=health.reboot_pending_since,
        events=[HealthEventView(at=e.at, source=e.source, event_id=e.event_id, category=e.category or "other",
                                level=e.level or "error", title=e.title or f"{e.source} {e.event_id}", message=e.message)
                for e in health.events],
    )


def _agent_at_least(device: Device, version: Tuple[int, ...]) -> bool:
    parsed = _parse_agent_version(device.agent_version)
    return parsed is not None and parsed[: len(version)] >= version


class MetricsQueryService:
    def __init__(self, db: Session):
        self.db = db

    # ── a device ────────────────────────────────────────────────────────────

    def device_metrics(self, device: Device, range_key: str, coarse: bool = False) -> DeviceMetrics:
        now = utcnow_naive()
        start = now - RANGES[range_key]
        policy = effective_policy(self.db, device)
        step = (self.db.get(DeviceTelemetryState, device.id) or DeviceTelemetryState()).sample_seconds or policy.sample_seconds
        has_agent = self.db.query(TelemetrySample.ts).filter(TelemetrySample.device_id == device.id).first() is not None \
            or self.db.query(TelemetryRollup1h.bucket).filter(TelemetryRollup1h.device_id == device.id).first() is not None

        if has_agent:
            points, resolution = self._agent_points(device.id, range_key, start, coarse=coarse)
            source = "agent"
        else:
            points, resolution = self._heartbeat_points(device.id, range_key, start)
            source = "heartbeat" if points else "none"

        coverage = Coverage(received=0, late=0, missing_minutes=0, off_minutes=0, pct=None)
        restarts: List[datetime] = []
        if has_agent and range_key in ("1h", "24h", "7d"):
            raw = (
                self.db.query(TelemetrySample.ts, TelemetrySample.uptime_s, TelemetrySample.source)
                .filter(TelemetrySample.device_id == device.id, TelemetrySample.ts >= start)
                .order_by(TelemetrySample.ts)
                .all()
            )
            samples = [(r[0], r[1], r[2]) for r in raw]
            coverage = _coverage_from_samples(samples, start, now, step)
            restarts = _restarts(samples, start)
        elif points:
            received = sum(p.samples for p in points)
            expected = sum(p.expected for p in points)
            coverage = Coverage(received=received, late=0, missing_minutes=0, off_minutes=0,
                                pct=round(received / expected * 100, 2) if expected else None)

        cpu_values = [p.cpu_avg for p in points if p.cpu_avg is not None]
        peak = max((p for p in points if p.cpu_max is not None), key=lambda p: p.cpu_max, default=None)
        weights = [(p.cpu_avg, p.samples) for p in points if p.cpu_avg is not None]
        mem_weights = [(p.mem_avg, p.samples) for p in points if p.mem_avg is not None]

        def weighted(pairs):
            total = sum(w for _, w in pairs)
            return round(sum(v * w for v, w in pairs) / total, 1) if total else None

        def peak_of(attr: str) -> Optional[float]:
            values = [getattr(p, attr) for p in points if getattr(p, attr) is not None]
            return round(max(values), 1) if values else None

        def avg_of(attr: str) -> Optional[float]:
            return weighted([(getattr(p, attr), p.samples) for p in points if getattr(p, attr) is not None])

        summary = MetricSummary(
            cpu_avg=weighted(weights), cpu_p95=_pct(cpu_values, 0.95),
            cpu_peak=round(peak.cpu_max, 1) if peak else None, cpu_peak_at=peak.t if peak else None,
            mem_avg=weighted(mem_weights),
            mem_peak=max((p.mem_max for p in points if p.mem_max is not None), default=None),
            rx_peak=max((p.rx_max for p in points if p.rx_max is not None), default=None),
            tx_peak=max((p.tx_max for p in points if p.tx_max is not None), default=None),
            disk_busy_avg=avg_of("disk_busy_avg"), disk_busy_peak=peak_of("disk_busy_max"),
            disk_read_peak=peak_of("disk_read_avg"), disk_write_peak=peak_of("disk_write_avg"),
            gw_ms_avg=avg_of("gw_ms_avg"), gw_ms_peak=peak_of("gw_ms_max"),
            gw_loss_avg=avg_of("gw_loss_avg"), wan_ms_avg=avg_of("wan_ms_avg"),
        )
        return DeviceMetrics(
            range=range_key, resolution=resolution, source=source, start=start, end=now, points=points,
            summary=summary, disks=disk_trends(self.db, device.id) if has_agent else [],
            coverage=coverage, delivery=_delivery(self.db, device, policy.version), policy=policy,
            restarts=restarts, alerts=self._alert_spans(device.id, start, now),
            processes=_process_peaks(points),
        )

    def _alert_spans(self, device_id: int, start: datetime, end: datetime) -> List[AlertSpan]:
        """Monitor alerts open at any time in the range, for the charts."""
        kinds = [k.value for k in set(METRIC_KIND.values())]
        rows = (
            self.db.query(DeviceAlert)
            .filter(
                DeviceAlert.device_id == device_id, DeviceAlert.kind.in_(kinds), DeviceAlert.created_at < end,
                (DeviceAlert.resolved_at.is_(None)) | (DeviceAlert.resolved_at >= start),
            )
            .order_by(DeviceAlert.created_at.desc())
            .limit(MAX_ALERT_SPANS)
            .all()
        )
        return [AlertSpan(
            id=a.id, kind=a.kind.value if hasattr(a.kind, "value") else str(a.kind),
            severity=a.severity.value if hasattr(a.severity, "value") else str(a.severity),
            message=a.message, start=max(a.created_at.replace(tzinfo=None), start),
            end=a.resolved_at.replace(tzinfo=None) if a.resolved_at else None,
        ) for a in reversed(rows)]

    def _agent_points(self, device_id: int, range_key: str, start: datetime,
                      coarse: bool = False) -> Tuple[List[MetricPoint], str]:
        if range_key == "1h" or (range_key == "24h" and not coarse):
            rows = (
                self.db.query(TelemetrySample)
                .filter(TelemetrySample.device_id == device_id, TelemetrySample.ts >= start)
                .order_by(TelemetrySample.ts).all()
            )
            points = []
            for r in rows:
                extra = {}
                for column, (avg_field, max_field) in _EXTRA_POINT.items():
                    value = getattr(r, column)
                    extra[avg_field] = value
                    if max_field:
                        extra[max_field] = value
                points.append(MetricPoint(
                    t=r.ts, samples=1, expected=1, cpu_avg=r.cpu, cpu_max=r.cpu, mem_avg=r.mem, mem_max=r.mem,
                    rx_avg=r.net_rx_bps, rx_max=r.net_rx_bps, tx_avg=r.net_tx_bps, tx_max=r.net_tx_bps,
                    disk_max=max((d.get("used_pct", 0) for d in monitored_disks(r.disks)), default=None) if r.disks else None,
                    top=r.top or None, **extra,
                ))
            return points, "1m"
        model = TelemetryRollup5m if range_key in ("24h", "7d") else TelemetryRollup1h
        rows = self.db.query(model).filter(model.device_id == device_id, model.bucket >= start).order_by(model.bucket).all()
        points = [MetricPoint(
            t=r.bucket, samples=r.samples, expected=r.expected, cpu_avg=r.cpu_avg, cpu_max=r.cpu_max,
            mem_avg=r.mem_avg, mem_max=r.mem_max, rx_avg=r.net_rx_avg, rx_max=r.net_rx_max,
            tx_avg=r.net_tx_avg, tx_max=r.net_tx_max, disk_max=r.disk_max, top=r.top or None,
            **{field: getattr(r, column) for field, column in _ROLLUP_COLUMN.items()},
        ) for r in rows]
        if range_key == "13mo":
            return self._fold_days(points), "1d"
        return points, "5m" if range_key in ("24h", "7d") else "1h"

    @staticmethod
    def _fold_days(points: List[MetricPoint]) -> List[MetricPoint]:
        days: Dict = defaultdict(list)
        for p in points:
            days[p.t.date()].append(p)
        out = []
        for day, items in sorted(days.items()):
            samples = sum(i.samples for i in items)

            def w(attr, items=items):
                pairs = [(getattr(i, attr), i.samples) for i in items if getattr(i, attr) is not None]
                total = sum(s for _, s in pairs)
                return round(sum(v * s for v, s in pairs) / total, 2) if total else None

            def mx(attr, items=items):
                vals = [getattr(i, attr) for i in items if getattr(i, attr) is not None]
                return max(vals) if vals else None

            busiest = max((i for i in items if i.top), key=lambda i: i.cpu_max or 0, default=None)
            out.append(MetricPoint(
                t=datetime(day.year, day.month, day.day), samples=samples, expected=sum(i.expected for i in items),
                cpu_avg=w("cpu_avg"), cpu_max=mx("cpu_max"), mem_avg=w("mem_avg"), mem_max=mx("mem_max"),
                rx_avg=w("rx_avg"), rx_max=mx("rx_max"), tx_avg=w("tx_avg"), tx_max=mx("tx_max"), disk_max=mx("disk_max"),
                top=busiest.top if busiest else None,
                **{f: w(f) for f in _AVG_FIELDS}, **{f: mx(f) for f in _MAX_FIELDS},
            ))
        return out

    def _heartbeat_points(self, device_id: int, range_key: str, start: datetime) -> Tuple[List[MetricPoint], str]:
        rows = (
            self.db.query(DeviceTelemetry)
            .filter(DeviceTelemetry.device_id == device_id, DeviceTelemetry.created_at >= start)
            .order_by(DeviceTelemetry.created_at).all()
        )
        points = [MetricPoint(
            t=r.created_at, samples=1, expected=1, cpu_avg=r.cpu_percent, cpu_max=r.cpu_percent,
            mem_avg=r.ram_percent, mem_max=r.ram_percent, disk_max=r.disk_percent,
        ) for r in rows]
        if range_key in ("30d", "13mo"):
            return self._fold_days(points), "1d"
        return points, "5m"

    def device_monitoring(self, device: Device) -> DeviceMonitoring:
        policy = effective_policy(self.db, device)
        now_ts = utcnow_naive()
        open_alerts = {
            a.kind.value if hasattr(a.kind, "value") else a.kind: a
            for a in self.db.query(DeviceAlert).filter(DeviceAlert.device_id == device.id, DeviceAlert.state == AlertState.OPEN).all()
        }
        latest = (
            self.db.query(TelemetrySample).filter(TelemetrySample.device_id == device.id)
            .order_by(TelemetrySample.ts.desc()).first()
        )
        disks = disk_trends(self.db, device.id) if latest else []
        inventory = DeviceInventoryService(self.db)
        health = inventory.get_health(device.id)
        posture = inventory.get_security_posture(device.id)
        new_agent = _agent_at_least(device, AGENT_METRICS_SINCE)

        statuses = []
        for monitor in policy.monitors:
            kind = METRIC_KIND.get(monitor.metric)
            alert = open_alerts.get(kind.value) if kind else None
            value, now_text, known = self._monitor_now(monitor, latest, disks, health, posture, new_agent, now_ts)
            if not monitor.enabled:
                state = "off"
            elif alert is not None:
                state = "firing"
            elif not known:
                state = "unknown"
            elif value is not None and monitor.metric in ("cpu", "mem", "disk", "net_rx_mbps", "net_tx_mbps",
                                                         "disk_busy", "gw_ms", "gw_loss"):
                near = monitor.threshold * (0.95 if monitor.op == ">" else 1.05)
                state = "watch" if (monitor.op == ">" and value >= near) or (monitor.op == "<" and value <= near) else "ok"
            else:
                state = "ok"
            statuses.append(MonitorStatus(
                key=monitor.key, metric=monitor.metric, rule=describe(monitor), severity=monitor.severity,
                enabled=monitor.enabled, state=state, now=now_text, alert_id=alert.id if alert else None,
            ))
        return DeviceMonitoring(
            policy=policy, monitors=statuses, delivery=_delivery(self.db, device, policy.version),
            health=_health_view(health) if health is not None else None,
        )

    @staticmethod
    def _monitor_now(monitor, latest, disks, health, posture, new_agent: bool, now_ts: datetime):
        """(value, words for "now", whether the platform knows) for one monitor."""
        metric = monitor.metric
        needs = "needs agent 2.1.33"
        if metric in ("cpu", "mem", "disk", "net_rx_mbps", "net_tx_mbps", "disk_busy", "gw_ms", "gw_loss"):
            if latest is None:
                return None, None, False
            value = None
            if metric == "cpu":
                value = latest.cpu
            elif metric == "mem":
                value = latest.mem
            elif metric == "disk":
                counted = monitored_disks(latest.disks)
                value = max((d.get("used_pct", 0) for d in counted), default=None)
            elif metric == "net_rx_mbps" and latest.net_rx_bps is not None:
                value = latest.net_rx_bps / 1e6
            elif metric == "net_tx_mbps" and latest.net_tx_bps is not None:
                value = latest.net_tx_bps / 1e6
            elif metric in ("disk_busy", "gw_ms", "gw_loss"):
                value = getattr(latest, metric)
                if value is None:
                    return None, needs if not new_agent else "no reading yet", False
            if value is None:
                return None, None, True
            unit = {"gw_ms": " ms", "net_rx_mbps": " Mb/s", "net_tx_mbps": " Mb/s"}.get(metric, "%")
            return value, f"now {value:.0f}{unit}", True
        if metric == "disk_forecast_days":
            if latest is None:
                return None, None, False
            days = [d.days_to_full for d in disks if d.days_to_full is not None and d.monitored]
            value = min(days) if days else None
            return value, f"{value:.0f} days" if value is not None else "stable", True
        if metric == "no_data":
            return None, "arriving" if latest is not None else None, latest is not None
        if metric == "service":
            count = len(monitor.target.split(",")) if monitor.target else 0
            if not new_agent:
                return None, needs, False
            return None, f"watching {count} service{'s' if count != 1 else ''}", True
        if metric == "security_score":
            if posture is None:
                return None, "needs agent 2.1.31", False
            score = posture_score(posture)
            return float(score), f"score {score}", True
        if health is None:
            return None, needs if not new_agent else "no report yet", False
        if metric == "disk_health":
            problems = disks_with_problems(health)
            if problems:
                first = problems[0]
                return float(len(problems)), f"{first.name}: {first.problem}", True
            n = len(health.disks)
            return 0.0, f"{n} disk{'s' if n != 1 else ''} healthy" if n else "no disks reported", True
        if metric == "critical_events":
            events = alerting_events(health, now_ts.replace(tzinfo=None))
            return float(len(events)), f"{len(events)} in 24 h" if events else "none in 24 h", True
        if metric == "reboot_pending_days":
            days = reboot_pending_days(health, now_ts)
            if days is None:
                return 0.0, "none pending", True
            return days, f"pending {days:.0f} day{'s' if round(days) != 1 else ''}" if days >= 1 else "pending today", True
        return None, None, False

    # ── a client ────────────────────────────────────────────────────────────

    def client_monitoring(self, devices: List[Device], range_key: str) -> ClientMonitoring:
        now = utcnow_naive()
        start = now - RANGES[range_key]
        ids = [d.id for d in devices]
        by_id = {d.id: d for d in devices}
        hourly: Dict[int, Dict[datetime, dict]] = defaultdict(dict)
        agent_ids = set()

        if ids:
            for r in self.db.query(TelemetryRollup1h).filter(TelemetryRollup1h.device_id.in_(ids), TelemetryRollup1h.bucket >= start).all():
                agent_ids.add(r.device_id)
                hourly[r.device_id][r.bucket] = {
                    "cpu_avg": r.cpu_avg, "cpu_max": r.cpu_max, "mem_avg": r.mem_avg, "mem_max": r.mem_max,
                    "disk_max": r.disk_max, "samples": r.samples, "expected": r.expected,
                }
            legacy = [i for i in ids if i not in agent_ids]
            if legacy:
                hour = self._hour_expr(DeviceTelemetry.created_at)
                rows = (
                    self.db.query(
                        DeviceTelemetry.device_id, hour.label("h"),
                        func.avg(DeviceTelemetry.cpu_percent), func.max(DeviceTelemetry.cpu_percent),
                        func.avg(DeviceTelemetry.ram_percent), func.max(DeviceTelemetry.ram_percent),
                        func.max(DeviceTelemetry.disk_percent), func.count(DeviceTelemetry.id),
                    )
                    .filter(DeviceTelemetry.device_id.in_(legacy), DeviceTelemetry.created_at >= start)
                    .group_by(DeviceTelemetry.device_id, hour)
                    .all()
                )
                for device_id, h, cpu_avg, cpu_max, mem_avg, mem_max, disk_max, count in rows:
                    bucket = h if isinstance(h, datetime) else datetime.fromisoformat(str(h))
                    hourly[device_id][bucket] = {
                        "cpu_avg": cpu_avg, "cpu_max": cpu_max, "mem_avg": mem_avg, "mem_max": mem_max,
                        "disk_max": disk_max, "samples": count, "expected": 12,
                    }

        # heatmap: average CPU per local hour of day
        heat_rows: List[HeatmapRow] = []
        hour_totals: Dict[int, List[float]] = defaultdict(list)
        for device in devices:
            cells: Dict[int, List[float]] = defaultdict(list)
            for bucket, v in hourly.get(device.id, {}).items():
                if v["cpu_avg"] is not None:
                    cells[_local_hour(bucket)].append(v["cpu_avg"])
            values = [round(sum(cells[h]) / len(cells[h]), 1) if cells.get(h) else None for h in range(24)]
            for h, v in enumerate(values):
                if v is not None:
                    hour_totals[h].append(v)
            peaks = [v["cpu_max"] for v in hourly.get(device.id, {}).values() if v["cpu_max"] is not None]
            heat_rows.append(HeatmapRow(device_id=device.id, name=device.display_name or device.hostname or f"#{device.id}",
                                        cells=values, peak=round(max(peaks), 1) if peaks else None))
        heat_rows.sort(key=lambda r: (r.peak is None, -(r.peak or 0)))
        busiest = max(((h, sum(v) / len(v)) for h, v in hour_totals.items() if v), key=lambda x: x[1], default=None)

        # trend across the client
        bucket_of = (lambda t: t) if range_key in ("24h", "7d") else (lambda t: datetime(t.year, t.month, t.day))
        trend_raw: Dict[datetime, Dict[str, List[float]]] = defaultdict(lambda: {"cpu": [], "cpu_max": [], "mem": []})
        for series in hourly.values():
            for bucket, v in series.items():
                slot = trend_raw[bucket_of(bucket)]
                if v["cpu_avg"] is not None:
                    slot["cpu"].append(v["cpu_avg"])
                if v["cpu_max"] is not None:
                    slot["cpu_max"].append(v["cpu_max"])
                if v["mem_avg"] is not None:
                    slot["mem"].append(v["mem_avg"])
        trend = [TrendPoint(t=t, cpu_avg=_avg(s["cpu"]), cpu_p95=_pct(s["cpu_max"], 0.95), mem_avg=_avg(s["mem"]))
                 for t, s in sorted(trend_raw.items())]

        # coverage (agent devices, 5-minute buckets that saw the device on)
        cov = Coverage(received=0, late=0, missing_minutes=0, off_minutes=0, pct=None)
        if agent_ids:
            row = self.db.query(func.sum(TelemetryRollup5m.samples), func.sum(TelemetryRollup5m.expected), func.sum(TelemetryRollup5m.late)) \
                .filter(TelemetryRollup5m.device_id.in_(list(agent_ids)), TelemetryRollup5m.bucket >= start).one()
            received, expected, late = int(row[0] or 0), int(row[1] or 0), int(row[2] or 0)
            cov = Coverage(received=received, late=late, missing_minutes=max(0, expected - received), off_minutes=0,
                           pct=round(min(received, expected) / expected * 100, 2) if expected else None)

        monitor_kinds = [k.value for k in set(METRIC_KIND.values())]
        alerts = self.db.query(DeviceAlert).filter(
            DeviceAlert.device_id.in_(ids or [-1]), DeviceAlert.created_at >= start, DeviceAlert.kind.in_(monitor_kinds)
        ).all()
        firing: Dict[int, int] = defaultdict(int)
        for a in alerts:
            if a.state == AlertState.OPEN:
                firing[a.device_id] += 1

        attention: List[AttentionItem] = []
        disks_at_risk = 0
        rows_out: List[ClientDeviceRow] = []
        for device in devices:
            series = hourly.get(device.id, {})
            name = device.display_name or device.hostname or f"#{device.id}"
            trends = disk_trends(self.db, device.id) if device.id in agent_ids else []
            trends = [d for d in trends if d.monitored]
            worst_disk = max(trends, key=lambda d: d.used_pct, default=None)
            for disk in trends:
                if disk.used_pct >= 90:
                    continue  # full now: counted below, not as a forecast
                if disk.days_to_90 is not None and disk.days_to_90 < 30:
                    disks_at_risk += 1 if disk.days_to_90 < 14 else 0
                    attention.append(AttentionItem(
                        device_id=device.id, name=name, kind="disk_forecast",
                        severity="critical" if disk.days_to_90 < 7 else "warning",
                        title=f"{name} · {disk.mount} fills up",
                        detail=f"{disk.used_pct:.0f}% used" + (f", grows {disk.growth_gb_per_day} GB/day" if disk.growth_gb_per_day else "")
                               + f": 90% in {disk.days_to_90:.0f} days" + (f", full in {disk.days_to_full:.0f}." if disk.days_to_full else "."),
                    ))
            hot_cpu = sum(1 for v in series.values() if (v["cpu_avg"] or 0) > 85)
            hot_mem = sum(1 for v in series.values() if (v["mem_avg"] or 0) > 90)
            if hot_cpu >= 3:
                attention.append(AttentionItem(device_id=device.id, name=name, kind="cpu_sustained", severity="warning",
                                               title=f"{name} · sustained CPU load", detail=f"Above 85% on average for {hot_cpu} h in this period."))
            if hot_mem >= 3:
                attention.append(AttentionItem(device_id=device.id, name=name, kind="mem_sustained", severity="warning",
                                               title=f"{name} · memory pressure", detail=f"Above 90% on average for {hot_mem} h in this period."))
            if device.last_seen and now - device.last_seen.replace(tzinfo=None) > timedelta(days=3):
                days = (now - device.last_seen.replace(tzinfo=None)).days
                attention.append(AttentionItem(device_id=device.id, name=name, kind="not_seen", severity="info",
                                               title=f"{name} · not seen for {days} days", detail="No heartbeat or telemetry since then."))
            samples = sum(v["samples"] for v in series.values())
            expected = sum(v["expected"] for v in series.values())
            coverage_pct = round(min(samples, expected) / expected * 100, 1) if expected and device.id in agent_ids else None
            if coverage_pct is not None and coverage_pct < 95:
                attention.append(AttentionItem(device_id=device.id, name=name, kind="gaps", severity="warning",
                                               title=f"{name} · gaps in telemetry", detail=f"{coverage_pct:.1f}% of minutes received while on."))
            ordered = [v for _, v in sorted(series.items())]
            step = max(1, len(ordered) // 40)
            spark = [round(ordered[i]["cpu_avg"], 1) if ordered[i]["cpu_avg"] is not None else None for i in range(0, len(ordered), step)][-40:]
            cpu_peaks = [v["cpu_max"] for v in ordered if v["cpu_max"] is not None]
            mem_peaks = [v["mem_max"] for v in ordered if v["mem_max"] is not None]
            disk_peaks = [v["disk_max"] for v in ordered if v["disk_max"] is not None]
            # A disk already at 90% or more is at risk now, whether or not it
            # still grows; older agents report one figure, read at the last hour.
            full_now = [(d.mount, d.used_pct) for d in trends if d.used_pct >= 90]
            if not trends and ordered and ordered[-1]["disk_max"] is not None and ordered[-1]["disk_max"] >= 90:
                full_now = [(None, ordered[-1]["disk_max"])]
            for mount, pct in full_now:
                disks_at_risk += 1
                label = f"{mount} " if mount else "disk "
                attention.append(AttentionItem(
                    device_id=device.id, name=name, kind="disk_forecast",
                    severity="critical" if pct >= 95 else "warning",
                    title=f"{name} · {label}{pct:.0f}% full",
                    detail=f"{100 - pct:.0f}% free now" + (" — the system disk." if not mount or mount.upper().startswith("C") else "."),
                ))
            rows_out.append(ClientDeviceRow(
                device_id=device.id, name=name, kind=classify_category(device),
                agent_version=device.agent_version, spark=spark,
                cpu_peak=round(max(cpu_peaks), 1) if cpu_peaks else None,
                mem_peak=round(max(mem_peaks), 1) if mem_peaks else None,
                disk_worst=worst_disk.mount if worst_disk else None,
                disk_worst_pct=worst_disk.used_pct if worst_disk else (round(max(disk_peaks), 1) if disk_peaks else None),
                coverage_pct=coverage_pct, one_minute=device.id in agent_ids, monitors_firing=firing.get(device.id, 0),
            ))
        for device_id, count in firing.items():
            device = by_id.get(device_id)
            if device is not None:
                attention.append(AttentionItem(device_id=device_id, name=device.display_name or device.hostname or f"#{device_id}",
                                               kind="monitor", severity="critical", title=f"{device.display_name or device.hostname} · {count} monitor alert(s) open",
                                               detail="Open in the device's Monitoring tab."))
        order = {"critical": 0, "warning": 1, "info": 2}
        attention.sort(key=lambda a: order[a.severity])
        rows_out.sort(key=lambda r: (-(r.monitors_firing), -(r.cpu_peak or 0)))
        all_cpu = [v["cpu_avg"] for s in hourly.values() for v in s.values() if v["cpu_avg"] is not None]
        reporting_since = now - timedelta(hours=24)
        return ClientMonitoring(
            range=range_key, devices_total=len(devices),
            devices_reporting=sum(1 for d in devices if d.last_seen and d.last_seen.replace(tzinfo=None) >= reporting_since),
            one_minute_devices=len(agent_ids), coverage_pct=cov.pct, coverage_breakdown=cov,
            monitor_alerts=len(alerts), monitor_alerts_open=sum(firing.values()),
            cpu_avg=_avg(all_cpu), busiest_hour=busiest[0] if busiest else None,
            busiest_hour_cpu=round(busiest[1], 1) if busiest else None, disks_at_risk=disks_at_risk,
            heatmap=heat_rows[:60], trend=trend, attention=attention[:12], devices=rows_out,
        )

    def _hour_expr(self, column):
        if self.db.get_bind().dialect.name == "postgresql":
            return func.date_trunc("hour", column)
        return func.strftime("%Y-%m-%d %H:00:00", column)

    # ── the pipeline ────────────────────────────────────────────────────────

    def pipeline_health(self) -> PipelineHealth:
        now = utcnow_naive()
        states = self.db.query(DeviceTelemetryState).all()
        recent = [s for s in states if s.last_upload_at and now - s.last_upload_at <= timedelta(hours=1)]
        ages = [(now - s.last_sample_at).total_seconds() for s in recent if s.last_sample_at]
        backlog = [s for s in states if s.pending > 30 or (s.oldest_pending_at and now - s.oldest_pending_at > timedelta(minutes=45))]
        behind = 0
        for state in states:
            device = self.db.get(Device, state.device_id)
            if device is not None and state.policy_version and state.policy_version != effective_policy(self.db, device).version:
                behind += 1
        samples_30d = int(self.db.query(func.coalesce(func.sum(TelemetryRollup1h.samples), 0))
                          .filter(TelemetryRollup1h.bucket >= now - timedelta(days=30)).scalar() or 0)
        return PipelineHealth(
            devices_online=self.db.query(func.count(Device.id)).filter(Device.status == DeviceStatus.ONLINE, Device.is_archived.is_(False)).scalar() or 0,
            devices_one_minute=len(recent), uploads_last_hour=len(recent),
            median_delay_seconds=round(median(ages), 0) if ages else None,
            devices_with_backlog=len(backlog),
            oldest_backlog_at=min((s.oldest_pending_at for s in backlog if s.oldest_pending_at), default=None),
            dropped_30d=sum(s.dropped_total or 0 for s in states), samples_30d=samples_30d,
            policy_behind=behind, storage=self._storage(),
        )

    def _storage(self) -> List[StorageTier]:
        tiers = [("1-minute", "2 days", "telemetry_samples"), ("5-minute", "8 days", "telemetry_rollup_5m"),
                 ("Hourly", "13 months", "telemetry_rollup_1h")]
        out = []
        postgres = self.db.get_bind().dialect.name == "postgresql"
        for name, keep, table in tiers:
            size = None
            if postgres:
                size = self.db.execute(text(
                    "SELECT COALESCE(SUM(pg_total_relation_size(relid)), 0) FROM pg_partition_tree(:t)"
                ), {"t": table}).scalar()
            out.append(StorageTier(name=name, keep=keep, bytes=int(size) if size is not None else None))
        return out
