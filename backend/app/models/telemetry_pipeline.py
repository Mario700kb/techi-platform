"""Telemetry pipeline: what agents measure every minute, kept at three
resolutions, plus what each agent reports about its own delivery.

An agent from 2.1.29 samples on the device, keeps the samples in a buffer on
disk and uploads them every 15 minutes; the platform stores each sample once
(device_id + ts is the key, so a re-sent batch changes nothing) and folds it
into 5-minute and hourly rollups that keep min, average, max and how many
samples arrived (coverage). Raw minutes are kept 7 days, 5-minute points 30
days, hourly points 13 months.

On PostgreSQL telemetry_samples is partitioned by day (the migration creates
it so); an expired day is dropped in one step instead of deleted row by row.
"""
from sqlalchemy import JSON, REAL, BigInteger, Boolean, Column, DateTime, Float, ForeignKey, Index, Integer, SmallInteger, String, Text

from app.core.time import utcnow_naive
from app.db.base import Base

SOURCE_AGENT = 1
SOURCE_HEARTBEAT = 2


class TelemetrySample(Base):
    __tablename__ = "telemetry_samples"

    device_id = Column(Integer, ForeignKey("devices.id", ondelete="CASCADE"), primary_key=True)
    ts = Column(DateTime, primary_key=True)  # UTC, minute the sample was taken
    seq = Column(BigInteger, nullable=False)
    cpu = Column(Float, nullable=True)
    mem = Column(Float, nullable=True)
    mem_used_mb = Column(Float, nullable=True)
    net_rx_bps = Column(Float, nullable=True)
    net_tx_bps = Column(Float, nullable=True)
    uptime_s = Column(BigInteger, nullable=True)
    disks = Column(JSON, nullable=True)  # [{"mount": "C:", "used_pct": 54.2, "free_gb": 108.5, "total_gb": 237.9}]
    source = Column(SmallInteger, nullable=False, default=SOURCE_AGENT)
    # Agent 2.1.33: disk activity (busiest volume's busy %, its average queue,
    # bytes/s read and written over all volumes), network quality (round trip
    # and loss to the default gateway, TCP connect time to the platform) and,
    # only in a busy minute (CPU >= 15% or memory >= 80%), the top processes
    # [{"n": "sqlservr.exe", "c": 41.5, "m": 6120.0}]. REAL: 4 bytes is plenty.
    disk_busy = Column(REAL, nullable=True)
    disk_queue = Column(REAL, nullable=True)
    disk_read_bps = Column(REAL, nullable=True)
    disk_write_bps = Column(REAL, nullable=True)
    gw_ms = Column(REAL, nullable=True)
    gw_loss = Column(REAL, nullable=True)
    wan_ms = Column(REAL, nullable=True)
    top = Column(JSON, nullable=True)


class _Rollup:
    device_id = Column(Integer, ForeignKey("devices.id", ondelete="CASCADE"), primary_key=True)
    bucket = Column(DateTime, primary_key=True)  # UTC start of the bucket
    samples = Column(Integer, nullable=False, default=0)
    expected = Column(Integer, nullable=False, default=0)
    late = Column(Integer, nullable=False, default=0)  # samples that arrived from the device buffer after an outage
    cpu_avg = Column(Float, nullable=True)
    cpu_min = Column(Float, nullable=True)
    cpu_max = Column(Float, nullable=True)
    mem_avg = Column(Float, nullable=True)
    mem_max = Column(Float, nullable=True)
    net_rx_avg = Column(Float, nullable=True)
    net_rx_max = Column(Float, nullable=True)
    net_tx_avg = Column(Float, nullable=True)
    net_tx_max = Column(Float, nullable=True)
    disk_max = Column(Float, nullable=True)  # fullest disk, used %
    disks = Column(JSON, nullable=True)  # per mount: last used %, free and total GB
    disk_busy_avg = Column(REAL, nullable=True)
    disk_busy_max = Column(REAL, nullable=True)
    disk_queue_avg = Column(REAL, nullable=True)
    disk_queue_max = Column(REAL, nullable=True)
    disk_read_avg = Column(REAL, nullable=True)
    disk_read_max = Column(REAL, nullable=True)
    disk_write_avg = Column(REAL, nullable=True)
    disk_write_max = Column(REAL, nullable=True)
    gw_ms_avg = Column(REAL, nullable=True)
    gw_ms_max = Column(REAL, nullable=True)
    gw_loss_avg = Column(REAL, nullable=True)
    gw_loss_max = Column(REAL, nullable=True)
    wan_ms_avg = Column(REAL, nullable=True)
    wan_ms_max = Column(REAL, nullable=True)
    top = Column(JSON, nullable=True)  # the top processes of the bucket's busiest minute


class TelemetryRollup5m(_Rollup, Base):
    __tablename__ = "telemetry_rollup_5m"
    __table_args__ = (Index("ix_telemetry_rollup_5m_bucket", "bucket"),)


class TelemetryRollup1h(_Rollup, Base):
    __tablename__ = "telemetry_rollup_1h"
    __table_args__ = (Index("ix_telemetry_rollup_1h_bucket", "bucket"),)


class DeviceTelemetryState(Base):
    """What the agent says about its own delivery, updated on each upload."""

    __tablename__ = "device_telemetry_state"

    device_id = Column(Integer, ForeignKey("devices.id", ondelete="CASCADE"), primary_key=True)
    last_seq = Column(BigInteger, nullable=False, default=0)
    last_upload_at = Column(DateTime, nullable=True)
    last_sample_at = Column(DateTime, nullable=True)
    pending = Column(Integer, nullable=False, default=0)  # samples still on the device after this upload
    oldest_pending_at = Column(DateTime, nullable=True)
    dropped_total = Column(BigInteger, nullable=False, default=0)  # samples the device had to discard, ever
    clock_offset_ms = Column(Integer, nullable=True)  # device clock minus server clock
    sample_seconds = Column(Integer, nullable=True)
    policy_version = Column(String(64), nullable=True)
    schema = Column(SmallInteger, nullable=True)


class MonitoringPolicy(Base):
    """What a set of devices measures and when it raises an alert.

    scope: "default" (every device), "device_type" (scope_value client|server),
    "client" or "group" (scope_value the id). The most specific matching policy
    wins for collection settings; its monitors override those of broader
    policies with the same key and add the rest."""

    __tablename__ = "monitoring_policies"

    id = Column(Integer, primary_key=True)
    name = Column(String(120), nullable=False)
    description = Column(Text, nullable=True)
    scope = Column(String(16), nullable=False)
    scope_value = Column(String(64), nullable=True)
    enabled = Column(Boolean, nullable=False, default=True)
    version = Column(Integer, nullable=False, default=1)
    sample_seconds = Column(Integer, nullable=False, default=60)
    upload_seconds = Column(Integer, nullable=False, default=900)
    buffer_mb = Column(Integer, nullable=False, default=50)
    keep_days = Column(Integer, nullable=False, default=7)
    monitors = Column(JSON, nullable=False, default=list)
    updated_at = Column(DateTime, nullable=False, default=utcnow_naive)
    updated_by = Column(String(120), nullable=True)
