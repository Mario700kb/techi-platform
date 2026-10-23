"""Stores an agent's telemetry upload exactly once and keeps the rollups current.

Each sample is keyed by (device_id, ts): a batch sent again after a lost
acknowledgement inserts nothing new. Only the 5-minute and hourly buckets that
received new samples are recomputed — from the raw minutes for 5-minute
buckets, from the 5-minute buckets for hours — so an upload costs a handful of
small writes however much history it carries.

The acknowledgement is the highest sequence number in the batch: duplicates
and samples too old to keep are acknowledged too, so the agent can let go of
them; the counts in the reply say what happened to each.
"""
import logging
from datetime import datetime, timedelta
from typing import Dict, Iterable, List, Optional, Set

from sqlalchemy import and_, insert, text
from sqlalchemy.exc import IntegrityError, OperationalError, ProgrammingError
from sqlalchemy.orm import Session

from app.core.time import ensure_utc, utcnow_naive
from app.models.device import Device
from app.models.telemetry_pipeline import (
    SOURCE_AGENT,
    DeviceTelemetryState,
    TelemetryRollup1h,
    TelemetryRollup5m,
    TelemetrySample,
)
from app.schemas.telemetry_pipeline import EffectivePolicy, TelemetryAck, TelemetryUpload

logger = logging.getLogger(__name__)

# A sample that reaches the platform this long after it was taken came from the
# device's buffer after an outage; counted separately so the coverage view can
# tell "late" from "on time".
SOURCE_AGENT_LATE = 3
RAW_KEEP = timedelta(days=7)
# A volume smaller than this (recovery, EFI, a small data partition) is kept
# and shown, but never decides "the fullest disk" nor raises a disk alert.
SMALL_VOLUME_GB = 5.0
FUTURE_TOLERANCE = timedelta(minutes=10)
CLOCK_CORRECT_ABOVE_MS = 2000


def floor_5m(ts: datetime) -> datetime:
    return ts.replace(minute=ts.minute - ts.minute % 5, second=0, microsecond=0)


def floor_1h(ts: datetime) -> datetime:
    return ts.replace(minute=0, second=0, microsecond=0)


def _naive(ts: datetime) -> datetime:
    return ensure_utc(ts).replace(tzinfo=None)


def _mean(values: List[float]) -> Optional[float]:
    return round(sum(values) / len(values), 2) if values else None


def monitored_disks(disks) -> list:
    """The volumes that count for disk monitoring: all but small ones (a
    volume whose size is unknown counts)."""
    return [d for d in (disks or []) if d.get("total_gb") is None or d.get("total_gb") >= SMALL_VOLUME_GB]


# Sample column → rollup columns (average, peak).
_EXTRA = {
    "disk_busy": ("disk_busy_avg", "disk_busy_max"),
    "disk_queue": ("disk_queue_avg", "disk_queue_max"),
    "disk_read_bps": ("disk_read_avg", "disk_read_max"),
    "disk_write_bps": ("disk_write_avg", "disk_write_max"),
    "gw_ms": ("gw_ms_avg", "gw_ms_max"),
    "gw_loss": ("gw_loss_avg", "gw_loss_max"),
    "wan_ms": ("wan_ms_avg", "wan_ms_max"),
}


def ensure_partitions(db: Session, days_back: int = 7, days_ahead: int = 3) -> int:
    """PostgreSQL: make sure daily partitions exist around today. Idempotent."""
    if db.get_bind().dialect.name != "postgresql":
        return 0
    created = 0
    today = utcnow_naive().date()
    for offset in range(-days_back, days_ahead + 1):
        day = today + timedelta(days=offset)
        name = f"telemetry_samples_{day:%Y%m%d}"
        exists = db.execute(
            text("SELECT to_regclass(:n) IS NOT NULL"), {"n": name}
        ).scalar()
        if not exists:
            db.execute(text(
                f"CREATE TABLE IF NOT EXISTS {name} PARTITION OF telemetry_samples "
                f"FOR VALUES FROM ('{day.isoformat()}') TO ('{(day + timedelta(days=1)).isoformat()}')"
            ))
            created += 1
    db.commit()
    return created


class TelemetryIngestService:
    def __init__(self, db: Session):
        self.db = db
        self.dialect = db.get_bind().dialect.name

    # ── upload ──────────────────────────────────────────────────────────────

    def ingest(self, device: Device, upload: TelemetryUpload, policy: EffectivePolicy) -> TelemetryAck:
        now = utcnow_naive()
        offset_ms = None
        if upload.agent_time is not None:
            offset_ms = int((_naive(upload.agent_time) - now).total_seconds() * 1000)
        correction = timedelta(milliseconds=offset_ms) if offset_ms and abs(offset_ms) > CLOCK_CORRECT_ABOVE_MS else timedelta(0)
        sample_seconds = upload.sample_seconds or policy.sample_seconds or 60
        late_after = timedelta(seconds=policy.upload_seconds * 1.5 + 60)

        rows: List[dict] = []
        rejected = 0
        max_seq = 0
        for sample in upload.samples:
            max_seq = max(max_seq, sample.seq)
            ts = (_naive(sample.ts) - correction).replace(microsecond=0)
            if ts < now - RAW_KEEP or ts > now + FUTURE_TOLERANCE:
                rejected += 1
                continue
            rows.append({
                "device_id": device.id, "ts": ts, "seq": sample.seq,
                "cpu": sample.cpu, "mem": sample.mem, "mem_used_mb": sample.mem_used_mb,
                "net_rx_bps": sample.net_rx_bps, "net_tx_bps": sample.net_tx_bps, "uptime_s": sample.uptime_s,
                "disks": [d.model_dump() for d in sample.disks] or None,
                "source": SOURCE_AGENT_LATE if now - ts > late_after else SOURCE_AGENT,
                "disk_busy": sample.disk_busy, "disk_queue": sample.disk_queue,
                "disk_read_bps": sample.disk_read_bps, "disk_write_bps": sample.disk_write_bps,
                "gw_ms": sample.gw_ms, "gw_loss": sample.gw_loss, "wan_ms": sample.wan_ms,
                "top": [t.model_dump(exclude_none=True) for t in sample.top] or None,
            })

        stored = self._insert(rows)
        duplicates = len(rows) - stored
        if stored:
            self._recompute(device.id, {r["ts"] for r in rows}, sample_seconds)

        state = self.db.get(DeviceTelemetryState, device.id)
        if state is None:
            state = DeviceTelemetryState(device_id=device.id, last_seq=0, dropped_total=0, pending=0)
            self.db.add(state)
        state.last_seq = max(state.last_seq or 0, max_seq)
        state.last_upload_at = now
        if rows:
            newest = max(r["ts"] for r in rows)
            state.last_sample_at = max(state.last_sample_at, newest) if state.last_sample_at else newest
        state.pending = upload.buffer.pending
        state.oldest_pending_at = _naive(upload.buffer.oldest_pending) if upload.buffer.oldest_pending else None
        state.dropped_total = max(state.dropped_total or 0, upload.buffer.dropped_total)
        state.clock_offset_ms = offset_ms
        state.sample_seconds = sample_seconds
        state.policy_version = upload.policy_version
        state.schema = upload.schema_version
        self.db.commit()

        if upload.events:
            from app.services.monitor_alert_service import MonitorAlertService, settled

            alerts = MonitorAlertService(self.db)
            for event in settled(upload.events):
                alerts.apply(device, event, policy)

        return TelemetryAck(
            ack_seq=max_seq, stored=stored, duplicates=duplicates, rejected=rejected,
            policy_version=policy.version, next_upload_seconds=policy.upload_seconds,
        )

    def _insert(self, rows: List[dict]) -> int:
        if not rows:
            return 0
        if self.dialect == "postgresql":
            from sqlalchemy.dialects.postgresql import insert as pg_insert

            stmt = pg_insert(TelemetrySample).values(rows).on_conflict_do_nothing(index_elements=["device_id", "ts"])
        else:
            stmt = insert(TelemetrySample).values(rows).prefix_with("OR IGNORE")
        # RETURNING names exactly the rows that went in; rowcount is -1 for
        # this statement on PostgreSQL.
        stmt = stmt.returning(TelemetrySample.ts)
        try:
            result = self.db.execute(stmt)
        except (IntegrityError, OperationalError, ProgrammingError) as exc:
            # A day with no partition yet (the nightly job did not run;
            # PostgreSQL reports it as a check violation):
            # create the partitions and try once more.
            self.db.rollback()
            if self.dialect != "postgresql" or "partition" not in str(exc).lower():
                raise
            ensure_partitions(self.db)
            result = self.db.execute(stmt)
        stored = len(result.all())
        self.db.flush()
        return stored

    # ── rollups ─────────────────────────────────────────────────────────────

    def _recompute(self, device_id: int, timestamps: Iterable[datetime], sample_seconds: int) -> None:
        buckets_5m = sorted({floor_5m(ts) for ts in timestamps})
        for bucket in buckets_5m:
            self._recompute_5m(device_id, bucket, sample_seconds)
        self.db.flush()
        for hour in sorted({floor_1h(b) for b in buckets_5m}):
            self._recompute_1h(device_id, hour, sample_seconds)

    def _recompute_5m(self, device_id: int, bucket: datetime, sample_seconds: int) -> None:
        samples = (
            self.db.query(TelemetrySample)
            .filter(TelemetrySample.device_id == device_id, TelemetrySample.ts >= bucket,
                    TelemetrySample.ts < bucket + timedelta(minutes=5))
            .order_by(TelemetrySample.ts)
            .all()
        )
        if not samples:
            return
        values = self._aggregate(samples)
        values["expected"] = max(1, 300 // max(sample_seconds, 1))
        self._upsert(TelemetryRollup5m, device_id, bucket, values)

    def _recompute_1h(self, device_id: int, hour: datetime, sample_seconds: int) -> None:
        parts = (
            self.db.query(TelemetryRollup5m)
            .filter(TelemetryRollup5m.device_id == device_id, TelemetryRollup5m.bucket >= hour,
                    TelemetryRollup5m.bucket < hour + timedelta(hours=1))
            .order_by(TelemetryRollup5m.bucket)
            .all()
        )
        if not parts:
            return
        total = sum(p.samples for p in parts)

        def weighted(attr: str) -> Optional[float]:
            pairs = [(getattr(p, attr), p.samples) for p in parts if getattr(p, attr) is not None]
            weight = sum(w for _, w in pairs)
            return round(sum(v * w for v, w in pairs) / weight, 2) if weight else None

        def peak(attr: str, fn=max) -> Optional[float]:
            vals = [getattr(p, attr) for p in parts if getattr(p, attr) is not None]
            return fn(vals) if vals else None

        values = {
            "samples": total,
            "late": sum(p.late or 0 for p in parts),
            # The 5-minute windows the device reported in, so an hour it was
            # only partly on (or the current one) is not counted as lost data.
            "expected": sum(p.expected for p in parts),
            "cpu_avg": weighted("cpu_avg"), "cpu_min": peak("cpu_min", min), "cpu_max": peak("cpu_max"),
            "mem_avg": weighted("mem_avg"), "mem_max": peak("mem_max"),
            "net_rx_avg": weighted("net_rx_avg"), "net_rx_max": peak("net_rx_max"),
            "net_tx_avg": weighted("net_tx_avg"), "net_tx_max": peak("net_tx_max"),
            "disk_max": peak("disk_max"),
            "disks": parts[-1].disks,
        }
        for avg_col, max_col in _EXTRA.values():
            values[avg_col] = weighted(avg_col)
            values[max_col] = peak(max_col)
        busiest = max((p for p in parts if p.top), key=lambda p: p.cpu_max or 0, default=None)
        values["top"] = busiest.top if busiest else None
        self._upsert(TelemetryRollup1h, device_id, hour, values)

    @staticmethod
    def _aggregate(samples: List[TelemetrySample]) -> dict:
        def col(attr: str) -> List[float]:
            return [getattr(s, attr) for s in samples if getattr(s, attr) is not None]

        cpu, mem, rx, tx = col("cpu"), col("mem"), col("net_rx_bps"), col("net_tx_bps")
        disk_peaks = [max(d.get("used_pct", 0) for d in monitored_disks(s.disks)) for s in samples
                      if monitored_disks(s.disks)]
        last_disks = next((s.disks for s in reversed(samples) if s.disks), None)
        extra = {}
        for column, (avg_col, max_col) in _EXTRA.items():
            values = col(column)
            extra[avg_col] = _mean(values)
            extra[max_col] = max(values) if values else None
        busiest = max((s for s in samples if s.top), key=lambda s: s.cpu or 0, default=None)
        extra["top"] = busiest.top if busiest else None
        return {
            **extra,
            "samples": len(samples),
            "late": sum(1 for s in samples if s.source == SOURCE_AGENT_LATE),
            "cpu_avg": _mean(cpu), "cpu_min": min(cpu) if cpu else None, "cpu_max": max(cpu) if cpu else None,
            "mem_avg": _mean(mem), "mem_max": max(mem) if mem else None,
            "net_rx_avg": _mean(rx), "net_rx_max": max(rx) if rx else None,
            "net_tx_avg": _mean(tx), "net_tx_max": max(tx) if tx else None,
            "disk_max": max(disk_peaks) if disk_peaks else None,
            "disks": last_disks,
        }

    def _upsert(self, model, device_id: int, bucket: datetime, values: Dict) -> None:
        row = self.db.get(model, (device_id, bucket))
        if row is None:
            row = model(device_id=device_id, bucket=bucket)
            self.db.add(row)
        for key, value in values.items():
            setattr(row, key, value)


def cleanup_telemetry_pipeline(db: Session) -> int:
    """Nightly: keep 7 days of minutes, 30 days of 5-minute points and 13
    months of hours. On PostgreSQL an expired day is a partition dropped in one
    step, and the coming days' partitions are created."""
    removed = 0
    now = utcnow_naive()
    if db.get_bind().dialect.name == "postgresql":
        ensure_partitions(db)
        cutoff = (now - RAW_KEEP - timedelta(days=1)).date()
        names = db.execute(text(
            "SELECT inhrelid::regclass::text FROM pg_inherits WHERE inhparent = 'telemetry_samples'::regclass"
        )).scalars().all()
        for name in names:
            stamp = name.rsplit("_", 1)[-1]
            if stamp.isdigit() and len(stamp) == 8 and stamp < cutoff.strftime("%Y%m%d"):
                db.execute(text(f"DROP TABLE IF EXISTS {name}"))
                removed += 1
        db.commit()
    else:
        removed += db.query(TelemetrySample).filter(TelemetrySample.ts < now - RAW_KEEP).delete(synchronize_session=False)
    # 5-minute rollups feed only the 7-day chart (30 days and longer read the
    # hourly ones); 30 days of them would take ~2 GB for 600 devices.
    removed += db.query(TelemetryRollup5m).filter(TelemetryRollup5m.bucket < now - timedelta(days=8)).delete(synchronize_session=False)
    removed += db.query(TelemetryRollup1h).filter(TelemetryRollup1h.bucket < now - timedelta(days=400)).delete(synchronize_session=False)
    db.commit()
    return removed


def devices_with_agent_monitoring(db: Session, device_ids: Set[int]) -> Set[int]:
    """Devices whose agent evaluates its own monitors (it has reported a policy
    version): the heartbeat's CPU/RAM/disk alerting stays off for them."""
    if not device_ids:
        return set()
    try:
        rows = db.query(DeviceTelemetryState.device_id).filter(
            and_(DeviceTelemetryState.device_id.in_(list(device_ids)), DeviceTelemetryState.policy_version.isnot(None))
        ).all()
    except Exception:
        # Never let monitoring take the heartbeat's own alerting down with it.
        logger.exception("telemetry: could not read agent monitoring state")
        db.rollback()
        return set()
    return {r[0] for r in rows}
