"""Patch compliance: what each device's agent last reported about Windows Update.

Compliant = no pending updates, no restart pending and an update installed in
the last 30 days. A snapshot of the latest inventory, not a history.
"""
from app.schemas.client_report import ReportKpi, ReportSection
from app.services.client_reports.common import (
    CRIT, INFO, WARN, Built, Issue, Recommendation, ReportContext, col, device_cells, device_columns,
    iso, json_dict, nice_date, parse_day, pct, plural,
)

KEY = "patch_compliance"
STALE_DAYS = 30


def _has_data(patch: dict) -> bool:
    return bool(patch) and (
        patch.get("pending_updates") is not None
        or bool(patch.get("last_update_at"))
        or patch.get("patch_state") not in (None, "", "unknown")
    )


def build(ctx: ReportContext) -> Built:
    inventories = ctx.inventories()
    today = ctx.today
    pending_rows, reboot_rows, stale_rows, nodata_rows = [], [], [], []
    with_data = compliant = 0
    pending_total = 0
    for device in ctx.devices:
        inventory = inventories.get(device.id)
        patch = json_dict(inventory.patch_json) if inventory is not None else {}
        if not _has_data(patch):
            reason = "Never sent an inventory" if inventory is None else "No Windows Update data from this agent"
            if (device.platform or "windows").lower() not in ("windows", ""):
                reason = "Not collected on this platform"
            nodata_rows.append({**device_cells(device), "agent": device.agent_version or "—",
                                "last_seen": iso(device.last_seen), "reason": reason, "_tone": "neutral"})
            continue
        with_data += 1
        try:
            pending = max(0, int(patch.get("pending_updates") or 0))
        except (TypeError, ValueError):
            pending = 0
        reboot = bool(patch.get("reboot_required"))
        last = parse_day(patch.get("last_update_at"))
        age = (today - last).days if last else None
        stale = age is None or age > STALE_DAYS
        pending_total += pending
        if pending == 0 and not reboot and not stale:
            compliant += 1
        base = {**device_cells(device), "pending": pending, "last_update": last.isoformat() if last else None,
                "age_days": age, "last_seen": iso(device.last_seen)}
        if pending:
            pending_rows.append({**base, "reboot": "Yes" if reboot else "No",
                                 "_tone": "crit" if pending >= 10 or stale else "warn"})
        if reboot:
            reboot_rows.append({**base, "_tone": "warn"})
        if stale:
            stale_rows.append({**base, "_tone": "crit"})

    pending_rows.sort(key=lambda r: (-r["pending"], r["device"].lower()))
    reboot_rows.sort(key=lambda r: r["device"].lower())
    stale_rows.sort(key=lambda r: (r["last_update"] or "", r["device"].lower()))
    nodata_rows.sort(key=lambda r: r["device"].lower())

    compliance = pct(compliant, with_data)
    tone = "neutral" if compliance is None else "ok" if compliance >= 95 else "warn" if compliance >= 80 else "crit"
    summary = [
        ReportKpi(label="Compliance", value=compliance, kind="percent", tone=tone,
                  hint=f"{compliant} of {with_data} devices with patch data"),
        ReportKpi(label="Pending updates", value=len(pending_rows), tone="warn" if pending_rows else "ok",
                  hint=f"{plural(pending_total, 'update')} waiting in total"),
        ReportKpi(label="Restart required", value=len(reboot_rows), tone="warn" if reboot_rows else "ok",
                  hint="Updates installed, restart pending"),
        ReportKpi(label=f"Not updated {STALE_DAYS}+ days", value=len(stale_rows), tone="crit" if stale_rows else "ok",
                  hint="Or no update date reported"),
        ReportKpi(label="No patch data", value=len(nodata_rows), tone="info" if nodata_rows else "neutral",
                  hint="Agent too old or never reported"),
    ]
    sections = [
        ReportSection(
            key="needs_updates", title="Needs updates",
            description="Devices with updates waiting to install, most first.",
            columns=[*device_columns(), col("pending", "Pending", "number"), col("last_update", "Last update", "date"),
                     col("age_days", "Days since", "number"), col("reboot", "Restart pending", "badge"),
                     col("last_seen", "Last seen", "datetime")],
            rows=pending_rows, empty="No device has pending updates.",
        ),
        ReportSection(
            key="reboot_required", title="Restart required",
            description="Updates are installed but take effect only after a restart.",
            columns=[*device_columns(), col("pending", "Pending", "number"), col("last_update", "Last update", "date"),
                     col("last_seen", "Last seen", "datetime")],
            rows=reboot_rows, empty="No device is waiting for a restart.",
        ),
        ReportSection(
            key="not_updated", title=f"Not updated in {STALE_DAYS}+ days",
            description="The last installed update is older than 30 days, or the device reports no date.",
            columns=[*device_columns(), col("last_update", "Last update", "date"), col("age_days", "Days since", "number"),
                     col("pending", "Pending", "number"), col("last_seen", "Last seen", "datetime")],
            rows=stale_rows, empty=f"Every device installed an update in the last {STALE_DAYS} days.",
        ),
        ReportSection(
            key="no_data", title="No patch data",
            description="These devices are not counted in the compliance figure.",
            columns=[*device_columns(), col("agent", "Agent"), col("last_seen", "Last seen", "datetime"),
                     col("reason", "Reason")],
            rows=nodata_rows, empty="Every device reports its patch state.",
        ),
    ]
    document = ctx.document(
        key=KEY, title="Patch compliance", subtitle=f"State reported by each device's agent as of {nice_date(today)}",
        summary=summary, sections=sections,
        notes=[f"Compliant: no pending updates, no restart pending and an update installed in the last {STALE_DAYS} days.",
               "Figures are the latest inventory each agent sent, not a history of the period."],
    )

    issues, recs = [], []
    if stale_rows:
        oldest = stale_rows[0]
        issues.append(Issue(CRIT, f"{plural(len(stale_rows), 'device')} not updated for {STALE_DAYS}+ days", KEY, len(stale_rows)))
        detail = f" (oldest: {oldest['device']}, last update {nice_date(parse_day(oldest['last_update']))})" if oldest["last_update"] else ""
        recs.append(Recommendation(80, f"Check Windows Update on the {plural(len(stale_rows), 'device')} not updated for {STALE_DAYS} days or more{detail}."))
    if pending_rows:
        issues.append(Issue(WARN, f"{plural(len(pending_rows), 'device')} with pending updates ({pending_total} in total)", KEY, len(pending_rows)))
        recs.append(Recommendation(60, f"Install the {plural(pending_total, 'pending update')} on {plural(len(pending_rows), 'device')}."))
    if reboot_rows:
        issues.append(Issue(WARN, f"{plural(len(reboot_rows), 'device')} waiting for a restart to finish updates", KEY, len(reboot_rows)))
        names = ", ".join(r["device"] for r in reboot_rows[:3])
        recs.append(Recommendation(55, f"Schedule a restart for the {plural(len(reboot_rows), 'device')} waiting to finish updates ({names}{', …' if len(reboot_rows) > 3 else ''})."))
    if nodata_rows:
        issues.append(Issue(INFO, f"{plural(len(nodata_rows), 'device')} without patch data", KEY, len(nodata_rows)))
    return Built(document, issues, recs, {"compliance_pct": compliance, "with_data": with_data, "compliant": compliant})
