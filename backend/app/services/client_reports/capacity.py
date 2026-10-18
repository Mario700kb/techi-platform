"""Disk capacity: full disks now and disks forecast to fill.

Agents from 2.1.29 upload per-disk samples to the telemetry pipeline; their
disks come from metrics_query_service.disk_trends (growth fitted over the last
14 days → days to 90% and to full). Older agents report one system-disk figure:
the latest heartbeat disk % and the inventory string "109 GB free / 237 GB
total" — no forecast for those.
"""
from datetime import timedelta
from typing import Dict, List

from sqlalchemy import func

from app.models.device_telemetry import DeviceTelemetry
from app.schemas.client_report import ReportKpi, ReportSection
from app.services.client_reports.common import (
    CRIT, WARN, Built, Issue, Recommendation, ReportContext, agent_at_least, col, device_cells,
    is_windows, nice_date, parse_storage, plural,
)
from app.services.metrics_query_service import disk_trends

KEY = "capacity"
PIPELINE_AGENT = "2.1.29"
FULL_PCT = 90.0
FORECAST_DAYS = 30
FORECAST_SHOWN_DAYS = 180
LOW_FREE_PCT = 15.0
HEARTBEAT_MAX_AGE = timedelta(days=7)


def _latest_heartbeat_disk(ctx: ReportContext, ids: List[int]) -> Dict[int, float]:
    if not ids:
        return {}
    since = (ctx.now - HEARTBEAT_MAX_AGE).replace(tzinfo=None)
    latest = (
        ctx.db.query(DeviceTelemetry.device_id, func.max(DeviceTelemetry.created_at).label("at"))
        .filter(DeviceTelemetry.device_id.in_(ids), DeviceTelemetry.created_at >= since,
                DeviceTelemetry.disk_percent.isnot(None))
        .group_by(DeviceTelemetry.device_id)
        .subquery()
    )
    rows = (
        ctx.db.query(DeviceTelemetry.device_id, DeviceTelemetry.disk_percent)
        .join(latest, (DeviceTelemetry.device_id == latest.c.device_id) & (DeviceTelemetry.created_at == latest.c.at))
        .all()
    )
    return {device_id: float(value) for device_id, value in rows if value is not None}


def collect_disks(ctx: ReportContext) -> List[dict]:
    if "disks" in ctx.cache:
        return ctx.cache["disks"]
    disks: List[dict] = []
    legacy = []
    for device in ctx.devices:
        found = []
        if agent_at_least(device, PIPELINE_AGENT):
            for trend in disk_trends(ctx.db, device.id):
                found.append({
                    "device": device, "mount": trend.mount, "used_pct": trend.used_pct, "free_gb": trend.free_gb,
                    "total_gb": trend.total_gb, "growth": trend.growth_gb_per_day, "days_to_90": trend.days_to_90,
                    "days_to_full": trend.days_to_full, "source": "Telemetry",
                })
        if found:
            disks.extend(found)
        else:
            legacy.append(device)
    heartbeat = _latest_heartbeat_disk(ctx, [d.id for d in legacy])
    for device in legacy:
        storage = parse_storage(device.storage)
        used = heartbeat.get(device.id)
        free = total = None
        if storage:
            free, total = storage
            if used is None:
                used = 100.0 * (total - free) / total
        if used is None:
            continue
        disks.append({
            "device": device, "mount": "C:" if is_windows(device) else "/", "used_pct": round(used, 1),
            "free_gb": free, "total_gb": total, "growth": None, "days_to_90": None, "days_to_full": None,
            "source": "Heartbeat",
        })
    ctx.cache["disks"] = disks
    return disks


def _free_pct(disk: dict) -> float:
    if disk["free_gb"] is not None and disk["total_gb"]:
        return 100.0 * disk["free_gb"] / disk["total_gb"]
    return 100.0 - disk["used_pct"]


def _row(disk: dict, tone: str) -> dict:
    return {**device_cells(disk["device"]), "disk": disk["mount"], "used_pct": disk["used_pct"],
            "free_gb": disk["free_gb"], "total_gb": disk["total_gb"], "growth": disk["growth"],
            "days_to_90": disk["days_to_90"], "days_to_full": disk["days_to_full"], "source": disk["source"],
            "_tone": tone}


def build(ctx: ReportContext) -> Built:
    disks = collect_disks(ctx)
    today = ctx.today
    at_risk = [d for d in disks if d["used_pct"] >= FULL_PCT]
    filling = [d for d in disks if d["used_pct"] < FULL_PCT and d["days_to_90"] is not None
               and d["days_to_90"] <= FORECAST_SHOWN_DAYS]
    soon = [d for d in filling if d["days_to_90"] <= FORECAST_DAYS]
    low_devices = {d["device"].id for d in disks if _free_pct(d) < LOW_FREE_PCT}
    free_total = round(sum(d["free_gb"] for d in disks if d["free_gb"] is not None), 1)

    at_risk_rows = sorted((_row(d, "crit") for d in at_risk), key=lambda r: -r["used_pct"])
    filling_rows = []
    for disk in sorted(filling, key=lambda d: d["days_to_90"]):
        row = _row(disk, "warn" if disk["days_to_90"] <= FORECAST_DAYS else "info")
        row["date_90"] = (today + timedelta(days=int(disk["days_to_90"]))).isoformat()
        filling_rows.append(row)
    all_rows = sorted(
        (_row(d, "crit" if d["used_pct"] >= FULL_PCT else "warn" if _free_pct(d) < LOW_FREE_PCT else "ok") for d in disks),
        key=lambda r: (-r["used_pct"], r["device"].lower()),
    )
    summary = [
        ReportKpi(label=f"Disks {FULL_PCT:g}%+ full", value=len(at_risk), tone="crit" if at_risk else "ok",
                  hint="Now"),
        ReportKpi(label=f"Reach {FULL_PCT:g}% within {FORECAST_DAYS} days", value=len(soon), tone="warn" if soon else "ok",
                  hint=f"Forecast from growth (agents {PIPELINE_AGENT}+)"),
        ReportKpi(label=f"Devices under {LOW_FREE_PCT:g}% free", value=len(low_devices), tone="warn" if low_devices else "ok",
                  hint="On any disk"),
        ReportKpi(label="Free space", value=free_total, tone="neutral",
                  hint=f"GB free on {plural(len(disks), 'disk')}"),
    ]
    disk_cols = [col("device", "Device"), col("disk", "Disk"), col("used_pct", "Used", "percent"),
                 col("free_gb", "Free (GB)", "number"), col("total_gb", "Size (GB)", "number")]
    sections = [
        ReportSection(
            key="at_risk", title="At risk now", description=f"Disks {FULL_PCT:g}% full or more.",
            columns=[*disk_cols, col("days_to_full", "Days to full", "number")],
            rows=at_risk_rows, empty=f"No disk is {FULL_PCT:g}% full.",
        ),
        ReportSection(
            key="filling_up", title="Filling up (forecast)",
            description=f"Disks expected to reach {FULL_PCT:g}% within {FORECAST_SHOWN_DAYS} days at their growth of the last 14 days.",
            columns=[*disk_cols[:3], col("growth", "Growth (GB/day)", "number"), col("days_to_90", f"Days to {FULL_PCT:g}%", "number"),
                     col("date_90", f"Reaches {FULL_PCT:g}%", "date")],
            rows=filling_rows, empty="No disk is growing towards 90% in the coming months.",
            note=f"Forecasts need agent {PIPELINE_AGENT} or later.",
        ),
        ReportSection(
            key="all_disks", title="All disks", description="Fullest first.",
            columns=[*disk_cols, col("growth", "Growth (GB/day)", "number"), col("source", "Source", "badge")],
            rows=all_rows, empty="No disk data.",
            note="Telemetry: per-disk samples (agent 2.1.29+). Heartbeat: the system disk from older agents, no forecast.",
        ),
    ]
    document = ctx.document(key=KEY, title="Disk capacity", subtitle=f"Disk state as of {nice_date(today)}",
                            summary=summary, sections=sections,
                            notes=["Figures are the latest each device reported, not an average of the period."])

    issues, recs = [], []
    for row in at_risk_rows[:5]:
        free = f", {row['free_gb']:g} GB free" if row["free_gb"] is not None else ""
        issues.append(Issue(CRIT, f"{row['device']} {row['disk']} is {row['used_pct']:g}% full{free}", KEY))
        recs.append(Recommendation(85, f"Free space on or extend {row['disk']} of {row['device']} ({row['used_pct']:g}% full{free})."))
    if soon:
        issues.append(Issue(WARN, f"{plural(len(soon), 'disk')} expected to reach {FULL_PCT:g}% within {FORECAST_DAYS} days", KEY, len(soon)))
        first = filling_rows[0]
        recs.append(Recommendation(65, f"Plan more storage for the {plural(len(soon), 'disk')} expected to reach {FULL_PCT:g}% "
                                       f"within {FORECAST_DAYS} days (first: {first['device']} {first['disk']}, about {nice_date(today + timedelta(days=int(first['days_to_90'])))})."))
    facts = {"at_risk": len(at_risk), "soon": len(soon), "low_devices": len(low_devices), "free_gb": free_total}
    return Built(document, issues, recs, facts)
