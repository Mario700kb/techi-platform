"""Agent 2.1.48: GPU use travels from the sample to the rollups and the chart."""
from datetime import datetime, timedelta, timezone

from app.core.time import utcnow_naive
from app.models.device import Device
from app.models.telemetry_pipeline import TelemetryRollup5m, TelemetrySample
from app.schemas.telemetry_pipeline import MetricPoint, TopProcess, UploadSample
from app.services.metrics_query_service import (
    _AVG_FIELDS,
    _EXTRA_POINT,
    _MAX_FIELDS,
    _ROLLUP_COLUMN,
    MetricsQueryService,
    _process_peaks,
)
from app.services.telemetry_ingest_service import _EXTRA
from tests.test_telemetry_pipeline import _ingest, _minutes, db  # noqa: F401


def _point(minute: int, top) -> MetricPoint:
    return MetricPoint(
        t=datetime(2026, 11, 6, 12, minute, tzinfo=timezone.utc), samples=1, expected=1, top=top,
    )


def test_an_upload_accepts_gpu_and_an_older_agent_simply_has_none():
    now = datetime.now(timezone.utc)
    sample = UploadSample(seq=1, ts=now, gpu=88.5, gpu_mem_mb=1024, top=[{"n": "DecodeProcess.exe", "c": 3, "m": 900, "g": 88.5}])
    assert sample.gpu == 88.5 and sample.gpu_mem_mb == 1024 and sample.top[0].g == 88.5
    older = UploadSample(seq=2, ts=now + timedelta(minutes=1), top=[{"n": "x.exe", "c": 3, "m": 9}])
    assert older.gpu is None and older.gpu_mem_mb is None and older.top[0].g is None


def test_gpu_is_kept_as_average_and_peak_at_every_resolution():
    assert _EXTRA["gpu"] == ("gpu_avg", "gpu_max")
    assert _EXTRA["gpu_mem_mb"] == ("gpu_mem_avg", "gpu_mem_max")
    assert _EXTRA_POINT["gpu"] == ("gpu_avg", "gpu_max")
    assert _EXTRA_POINT["gpu_mem_mb"] == ("gpu_mem_avg", "gpu_mem_max")
    for field in ("gpu_avg", "gpu_mem_avg"):
        assert field in _AVG_FIELDS and _ROLLUP_COLUMN[field] == field
    for field in ("gpu_max", "gpu_mem_max"):
        assert field in _MAX_FIELDS and _ROLLUP_COLUMN[field] == field


def test_busiest_processes_carry_their_gpu_peak():
    peaks = _process_peaks([
        _point(1, [TopProcess(n="DecodeProcess.exe", c=2, m=900, g=40)]),
        _point(2, [TopProcess(n="DecodeProcess.exe", c=5, m=950, g=91.5), TopProcess(n="MsMpEng.exe", c=30, m=300)]),
    ])
    by_name = {p.name: p for p in peaks}
    assert by_name["DecodeProcess.exe"].gpu_peak == 91.5
    assert by_name["MsMpEng.exe"].gpu_peak is None


def test_gpu_from_an_upload_reaches_the_rollups_and_the_chart(db):  # noqa: F811
    start = utcnow_naive().replace(minute=0, second=0, microsecond=0) - timedelta(hours=2)
    samples = _minutes(start, 10)
    for i, sample in enumerate(samples):
        sample.update(gpu=90.0 if i == 7 else 10.0, gpu_mem_mb=2048.0)
    samples[7]["top"] = [{"n": "DecodeProcess.exe", "c": 3.0, "m": 900.0, "g": 88.5}]
    _ingest(db, samples)

    stored = db.query(TelemetrySample).filter(TelemetrySample.seq == 8).one()
    assert stored.gpu == 90.0 and stored.gpu_mem_mb == 2048.0
    five = db.get(TelemetryRollup5m, (924, start + timedelta(minutes=5)))
    assert five.gpu_max == 90.0 and five.gpu_avg == 26.0 and five.gpu_mem_max == 2048.0

    metrics = MetricsQueryService(db).device_metrics(db.get(Device, 924), "24h")
    assert metrics.summary.gpu_peak == 90.0 and metrics.summary.gpu_mem_peak == 2048.0
    assert any(p.gpu_max == 90.0 for p in metrics.points)
    assert metrics.processes[0].name == "DecodeProcess.exe" and metrics.processes[0].gpu_peak == 88.5


def test_a_device_without_a_gpu_reading_keeps_null_not_zero(db):  # noqa: F811
    start = utcnow_naive().replace(minute=0, second=0, microsecond=0) - timedelta(hours=2)
    _ingest(db, _minutes(start, 10))
    metrics = MetricsQueryService(db).device_metrics(db.get(Device, 924), "24h")
    assert metrics.summary.gpu_peak is None and all(p.gpu_avg is None for p in metrics.points)
