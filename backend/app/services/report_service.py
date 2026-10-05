import csv
import io
import logging
import re
from datetime import datetime, timedelta
from pathlib import Path
from typing import Optional

from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.scope import AllowedScope
from app.core.time import format_display, to_display, utcnow
from app.models.report import ReportCadence, ReportFormat, ReportRun, ReportRunStatus, ReportSchedule
from app.models.device import Device
from app.models.device_group import DeviceGroup
from app.services.device_report import SECTION_ORDER, SECTION_TITLES, build_device_snapshot, device_csv
from app.services.report_output import csv_cell, safe_text
from app.services.report_pdf import render_report_pdf
from app.repositories.alert_repository import AlertRepository
from app.repositories.client_repository import ClientRepository
from app.repositories.device_repository import DeviceRepository
from app.repositories.report_repository import ReportRunRepository, ReportScheduleRepository
from app.services.device_overview_service import DeviceOverviewService

logger = logging.getLogger(__name__)


def next_schedule_time(
    cadence: str,
    *,
    hour_utc: int,
    day_of_week: Optional[int] = None,
    day_of_month: Optional[int] = None,
    after: Optional[datetime] = None,
) -> datetime:
    now = after or utcnow()
    if cadence == ReportCadence.DAILY.value:
        candidate = now.replace(hour=hour_utc, minute=0, second=0, microsecond=0)
        return candidate if candidate > now else candidate + timedelta(days=1)
    if cadence == ReportCadence.WEEKLY.value:
        target = 0 if day_of_week is None else day_of_week
        days = (target - now.weekday()) % 7
        candidate = (now + timedelta(days=days)).replace(hour=hour_utc, minute=0, second=0, microsecond=0)
        return candidate if candidate > now else candidate + timedelta(days=7)
    target = 1 if day_of_month is None else day_of_month
    year, month = now.year, now.month
    candidate = datetime(year, month, target, hour_utc, tzinfo=now.tzinfo)
    if candidate <= now:
        if month == 12:
            year, month = year + 1, 1
        else:
            month += 1
        candidate = datetime(year, month, target, hour_utc, tzinfo=now.tzinfo)
    return candidate


def _value(value) -> str:
    raw = getattr(value, "value", value)
    return "" if raw is None else str(raw)


def _safe_name(value: str) -> str:
    compact = re.sub(r"[^A-Za-z0-9._-]+", "-", value.strip()).strip("-.")
    return compact[:80] or "client"


class ReportService:
    def __init__(self, db: Session):
        self.db = db
        self.runs = ReportRunRepository(db)
        self.schedules = ReportScheduleRepository(db)

    def client_or_none(self, client_id: int):
        return ClientRepository(self.db).get(client_id)

    def generate(
        self,
        *,
        client_id: int,
        report_format: str,
        period_days: int,
        generated_by: str,
        schedule_id: Optional[int] = None,
        period_end: Optional[datetime] = None,
        period_start: Optional[datetime] = None,
    ) -> ReportRun:
        client = self.client_or_none(client_id)
        if client is None or not client.is_active:
            raise ValueError("Client not found")
        end = period_end or utcnow()
        start = period_start or end - timedelta(days=period_days)
        run = self.runs.create(
            schedule_id=schedule_id,
            client_id=client.id,
            client_name=client.name,
            report_format=report_format,
            period_start=start,
            period_end=end,
            status=ReportRunStatus.PENDING.value,
            generated_by=generated_by,
        )
        try:
            snapshot = self._snapshot(client.id, client.name, start, end, generated_by)
            content = self._render(snapshot, report_format)
            filename = f"CLIENT_{_safe_name(safe_text(client.name))}_Full_{to_display(snapshot['generated_at']):%Y%m%d_%H%M}.{report_format}"
            storage_root = Path(settings.REPORT_STORAGE_DIR).resolve()
            storage_root.mkdir(parents=True, exist_ok=True)
            path = storage_root / f"{run.id}-{filename}"
            path.write_bytes(content)
            return self.runs.mark_completed(
                run, filename=filename, storage_path=str(path), size_bytes=len(content)
            )
        except Exception as exc:
            logger.exception("Report generation failed run=%s client=%s", run.id, client.id)
            self.runs.mark_failed(run, str(exc) or exc.__class__.__name__)
            raise

    def generate_device(
        self, *, device_id: int, report_type: str, report_format: str,
        period_start: datetime, period_end: datetime, generated_by: str,
    ) -> ReportRun:
        device = self.db.query(Device).filter(Device.id == device_id).first()
        if device is None:
            raise ValueError("Device not found")
        client = self.client_or_none(device.client_id) if device.client_id else None
        client_name = client.name if client else "Unassigned"
        group = self.db.query(DeviceGroup).filter(DeviceGroup.id == device.group_id).first() if device.group_id else None
        device_name = device.hostname or device.display_name or f"Device #{device.id}"
        run = self.runs.create(
            client_id=client.id if client else None,
            client_name=client_name, scope_type="device", device_id=device.id,
            device_name=device_name, group_id=device.group_id, report_type=report_type,
            report_format=report_format, period_start=period_start, period_end=period_end,
            status=ReportRunStatus.PENDING.value, generated_by=generated_by,
        )
        try:
            snapshot = build_device_snapshot(
                self.db, device, client_name, group.name if group else "Unassigned",
                report_type, period_start, period_end, generated_by,
            )
            if report_format == ReportFormat.PDF.value:
                content = render_report_pdf(
                    scope="device", target=snapshot["device_name"],
                    report_type=SECTION_TITLES.get(report_type, report_type),
                    period_start=period_start, period_end=period_end,
                    generated_at=snapshot["generated_at"], generated_by=generated_by,
                    summary=[(key.replace("_", " ").title(), value) for key, value in snapshot["summary"].items()],
                    sections=[(SECTION_TITLES[key], section["headers"], section["rows"], section["note"])
                              for key in SECTION_ORDER if (section := snapshot["sections"].get(key)) is not None],
                )
            elif report_format == ReportFormat.CSV.value and report_type != "full":
                content = device_csv(snapshot)
            else:
                raise ValueError("Unsupported device report format")
            filename = f"DEVICE_{_safe_name(safe_text(device_name))}_{report_type}_{to_display(snapshot['generated_at']):%Y%m%d_%H%M}.{report_format}"
            root = Path(settings.REPORT_STORAGE_DIR).resolve()
            root.mkdir(parents=True, exist_ok=True)
            path = root / f"{run.id}-{filename}"
            path.write_bytes(content)
            return self.runs.mark_completed(run, filename=filename, storage_path=str(path), size_bytes=len(content))
        except Exception as exc:
            logger.exception("Device report generation failed run=%s device=%s", run.id, device_id)
            self.runs.mark_failed(run, str(exc) or exc.__class__.__name__)
            raise

    def _snapshot(self, client_id: int, client_name: str, start: datetime, end: datetime, generated_by: str) -> dict:
        scope = AllowedScope(client_ids=frozenset({client_id}))
        overview = DeviceOverviewService(self.db).get_overview(scope)
        devices = DeviceRepository(self.db).get_multi(client_id=client_id, limit=10000, scope=scope)
        alerts = AlertRepository(self.db).get_client_activity(client_id, start, end)
        alert_counts = AlertRepository(self.db).count_client_activity(client_id, start, end)
        open_alerts = [alert for alert in alerts if _value(alert.state) == "open"]
        return {
            "client_id": client_id,
            "client_name": client_name,
            "period_start": start,
            "period_end": end,
            "generated_at": utcnow(),
            "generated_by": generated_by,
            "overview": overview,
            "devices": devices,
            "alerts": alerts,
            "alert_counts": alert_counts,
            "open_alerts": open_alerts,
            "alerts_truncated": alert_counts.get("total", 0) > len(alerts),
        }

    def _render(self, snapshot: dict, report_format: str) -> bytes:
        if report_format == ReportFormat.CSV.value:
            return self._render_csv(snapshot)
        if report_format == ReportFormat.PDF.value:
            return self._render_pdf(snapshot)
        raise ValueError("Unsupported report format")

    @staticmethod
    def _render_csv(snapshot: dict) -> bytes:
        output = io.StringIO(newline="")
        writer = csv.writer(output)
        overview = snapshot["overview"]
        writer.writerow(["TECHI Client Fleet Report", csv_cell(snapshot["client_name"])])
        writer.writerow(["Period", to_display(snapshot["period_start"]).isoformat(), to_display(snapshot["period_end"]).isoformat()])
        writer.writerow(["Generated", to_display(snapshot["generated_at"]).isoformat()])
        writer.writerow(["Generated By", csv_cell(snapshot["generated_by"])])
        writer.writerow([])
        writer.writerow(["Fleet summary"])
        writer.writerow(["Total", "Online", "Stale", "Offline", "Average health", "Critical health", "Warnings", "Needs updates"])
        writer.writerow([
            overview.stats.total, overview.stats.online, overview.stats.stale, overview.stats.offline,
            overview.average_health if overview.average_health is not None else "",
            overview.critical, overview.warnings, overview.needs_updates,
        ])
        writer.writerow([])
        writer.writerow(["Devices"])
        writer.writerow(["Hostname", "Status", "Platform", "OS", "Agent version", "Local IP", "Public IP", "Last seen"])
        for device in snapshot["devices"]:
            writer.writerow([
                csv_cell(device.display_name or device.hostname), csv_cell(_value(device.status)), csv_cell(device.platform or "windows"),
                csv_cell(device.os_caption or device.os_name or ""), csv_cell(device.agent_version or ""), csv_cell(device.local_ip or ""),
                csv_cell(device.public_ip or ""), to_display(device.last_seen).isoformat() if device.last_seen else "",
            ])
        writer.writerow([])
        writer.writerow(["Alert activity"])
        if snapshot["alerts_truncated"]:
            writer.writerow(["Notice", f"Detail rows limited to {len(snapshot['alerts'])}; summary total is {snapshot['alert_counts'].get('total', 0)}"])
        writer.writerow(["Created", "Device ID", "Severity", "Kind", "State", "Message"])
        for alert in snapshot["alerts"]:
            writer.writerow([
                to_display(alert.created_at).isoformat(), alert.device_id, _value(alert.severity), _value(alert.kind),
                _value(alert.state), csv_cell(alert.message),
            ])
        return output.getvalue().encode("utf-8-sig")

    @staticmethod
    def _render_pdf(snapshot: dict) -> bytes:
        overview = snapshot["overview"]
        counts = snapshot["alert_counts"]
        summary = [
            ("Total devices", overview.stats.total), ("Online / stale / offline", f"{overview.stats.online} / {overview.stats.stale} / {overview.stats.offline}"),
            ("Average health", overview.average_health if overview.average_health is not None else "N/A"),
            ("Critical / warning", f"{overview.critical} / {overview.warnings}"),
            ("Alerts in period", counts.get("total", 0)), ("Open alerts in exported activity", len(snapshot["open_alerts"])),
        ]
        devices = [[d.display_name or d.hostname, _value(d.status), d.platform or "windows",
                    d.os_caption or d.os_name or "", d.agent_version or "",
                    format_display(d.last_seen) if d.last_seen else "Never"] for d in snapshot["devices"]]
        alerts = [[format_display(a.created_at), a.device_id, _value(a.severity),
                   _value(a.kind), _value(a.state), a.message] for a in snapshot["alerts"]]
        return render_report_pdf(
            scope="client", target=snapshot["client_name"], report_type="Full",
            period_start=snapshot["period_start"], period_end=snapshot["period_end"],
            generated_at=snapshot["generated_at"], generated_by=snapshot["generated_by"],
            summary=summary, sections=[
                ("Device Inventory", ["Hostname", "Status", "Platform", "OS", "Agent", "Last seen"], devices, "Current fleet snapshot."),
                ("Alert Activity", ["Created", "Device ID", "Severity", "Kind", "State", "Message"], alerts,
                 f"Showing {len(alerts)} of {counts.get('total', 0)} alerts." if snapshot["alerts_truncated"] else "Alerts opened in the reporting period."),
            ],
        )

    def create_schedule(self, **values) -> ReportSchedule:
        values["next_run_at"] = next_schedule_time(
            values["cadence"], hour_utc=values["hour_utc"],
            day_of_week=values.get("day_of_week"), day_of_month=values.get("day_of_month"),
        )
        return self.schedules.create(**values)

    def update_schedule(self, schedule: ReportSchedule, **updates) -> ReportSchedule:
        effective = {
            "cadence": updates.get("cadence", schedule.cadence),
            "hour_utc": updates.get("hour_utc", schedule.hour_utc),
            "day_of_week": updates.get("day_of_week", schedule.day_of_week),
            "day_of_month": updates.get("day_of_month", schedule.day_of_month),
        }
        cadence = effective["cadence"]
        if cadence == ReportCadence.WEEKLY.value and effective["day_of_week"] is None:
            raise ValueError("day_of_week is required for weekly schedules")
        if cadence == ReportCadence.MONTHLY.value and effective["day_of_month"] is None:
            raise ValueError("day_of_month is required for monthly schedules")
        if any(key in updates for key in ("cadence", "hour_utc", "day_of_week", "day_of_month")):
            updates["next_run_at"] = next_schedule_time(**effective)
        return self.schedules.update(schedule, **updates)

    @staticmethod
    def resolve_download_path(run: ReportRun) -> Path:
        if run.status != ReportRunStatus.COMPLETED.value or not run.storage_path or not run.filename:
            raise FileNotFoundError("Report file is not available")
        root = Path(settings.REPORT_STORAGE_DIR).resolve()
        path = Path(run.storage_path).resolve()
        if root != path.parent or not path.is_file():
            raise FileNotFoundError("Report file is not available")
        return path

    def cleanup_expired(self) -> int:
        cutoff = utcnow() - timedelta(days=settings.REPORT_RETENTION_DAYS)
        rows = self.runs.list_expired(cutoff)
        for row in rows:
            if row.storage_path:
                try:
                    path = Path(row.storage_path).resolve()
                    if path.parent == Path(settings.REPORT_STORAGE_DIR).resolve():
                        path.unlink(missing_ok=True)
                except OSError:
                    logger.exception("Unable to remove expired report file run=%s", row.id)
        self.runs.delete_many(rows)
        return len(rows)

    def delete_run(self, run: ReportRun) -> bool:
        """Delete one report run's DB record and, if present, its stored
        artifact. Deleting a generated run never touches its parent
        `ReportSchedule` (a schedule outlives any one of its generated runs).
        Returns True if the on-disk file was actually removed, False if it
        was already missing (not an error — just reported so the caller can
        surface it, matching cleanup_expired's tolerant/logged pattern)."""
        file_removed = False
        if run.storage_path:
            try:
                path = Path(run.storage_path).resolve()
                root = Path(settings.REPORT_STORAGE_DIR).resolve()
                if path.parent == root:
                    file_removed = path.is_file()
                    path.unlink(missing_ok=True)
                else:
                    logger.warning(
                        "Report run %s storage_path escapes REPORT_STORAGE_DIR — skipping unlink", run.id
                    )
            except OSError:
                logger.exception("Unable to remove report file for run=%s", run.id)
        self.runs.delete(run)
        return file_removed
