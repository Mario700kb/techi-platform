import csv
import io
import logging
import re
import textwrap
from datetime import datetime, timedelta
from pathlib import Path
from typing import Optional

from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.scope import AllowedScope
from app.core.time import utcnow
from app.models.report import ReportCadence, ReportFormat, ReportRun, ReportRunStatus, ReportSchedule
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


def _pdf_escape(value: str) -> str:
    return value.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")


def _simple_pdf(lines: list[str]) -> bytes:
    """Create a dependency-free, standards-compliant, paginated PDF.

    Reporting stays deployable without a second rendering service or browser.
    The layout is intentionally text-first so every value remains selectable.
    """
    wrapped: list[str] = []
    for line in lines:
        wrapped.extend(textwrap.wrap(str(line), width=94, replace_whitespace=False) or [""])
    pages = [wrapped[i:i + 48] for i in range(0, len(wrapped), 48)] or [[""]]
    objects: list[bytes] = []
    page_ids = [4 + index * 2 for index in range(len(pages))]
    objects.append(b"<< /Type /Catalog /Pages 2 0 R >>")
    objects.append(f"<< /Type /Pages /Kids [{' '.join(f'{pid} 0 R' for pid in page_ids)}] /Count {len(pages)} >>".encode())
    objects.append(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")
    for index, page_lines in enumerate(pages):
        page_id = page_ids[index]
        content_id = page_id + 1
        stream_parts = ["BT", "/F1 9 Tf", "48 744 Td", "12 TL"]
        for line_index, line in enumerate(page_lines):
            if line_index:
                stream_parts.append("T*")
            stream_parts.append(f"({_pdf_escape(line)}) Tj")
        stream_parts.append("ET")
        stream = "\n".join(stream_parts).encode("latin-1", errors="replace")
        objects.append(
            f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents {content_id} 0 R >>".encode()
        )
        objects.append(f"<< /Length {len(stream)} >>\nstream\n".encode() + stream + b"\nendstream")

    output = io.BytesIO()
    output.write(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")
    offsets = [0]
    for number, obj in enumerate(objects, start=1):
        offsets.append(output.tell())
        output.write(f"{number} 0 obj\n".encode())
        output.write(obj)
        output.write(b"\nendobj\n")
    xref = output.tell()
    output.write(f"xref\n0 {len(objects) + 1}\n".encode())
    output.write(b"0000000000 65535 f \n")
    for offset in offsets[1:]:
        output.write(f"{offset:010d} 00000 n \n".encode())
    output.write(f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode())
    return output.getvalue()


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
    ) -> ReportRun:
        client = self.client_or_none(client_id)
        if client is None or not client.is_active:
            raise ValueError("Client not found")
        end = period_end or utcnow()
        start = end - timedelta(days=period_days)
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
            snapshot = self._snapshot(client.id, client.name, start, end)
            content = self._render(snapshot, report_format)
            filename = f"techi-{_safe_name(client.name)}-{end:%Y%m%d-%H%M%S}.{report_format}"
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

    def _snapshot(self, client_id: int, client_name: str, start: datetime, end: datetime) -> dict:
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
        writer.writerow(["TECHI Client Fleet Report", snapshot["client_name"]])
        writer.writerow(["Period", snapshot["period_start"].isoformat(), snapshot["period_end"].isoformat()])
        writer.writerow(["Generated UTC", snapshot["generated_at"].isoformat()])
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
                device.display_name or device.hostname, _value(device.status), device.platform or "windows",
                device.os_caption or device.os_name or "", device.agent_version or "", device.local_ip or "",
                device.public_ip or "", device.last_seen.isoformat() if device.last_seen else "",
            ])
        writer.writerow([])
        writer.writerow(["Alert activity"])
        if snapshot["alerts_truncated"]:
            writer.writerow(["Notice", f"Detail rows limited to {len(snapshot['alerts'])}; summary total is {snapshot['alert_counts'].get('total', 0)}"])
        writer.writerow(["Created UTC", "Device ID", "Severity", "Kind", "State", "Message"])
        for alert in snapshot["alerts"]:
            writer.writerow([
                alert.created_at.isoformat(), alert.device_id, _value(alert.severity), _value(alert.kind),
                _value(alert.state), alert.message,
            ])
        return output.getvalue().encode("utf-8-sig")

    @staticmethod
    def _render_pdf(snapshot: dict) -> bytes:
        overview = snapshot["overview"]
        counts = snapshot["alert_counts"]
        lines = [
            "TECHI PLATFORM — CLIENT FLEET REPORT",
            f"Client: {snapshot['client_name']}",
            f"Reporting period: {snapshot['period_start']:%Y-%m-%d} to {snapshot['period_end']:%Y-%m-%d} (UTC)",
            f"Generated: {snapshot['generated_at']:%Y-%m-%d %H:%M UTC}",
            "",
            "FLEET HEALTH",
            f"Total devices: {overview.stats.total} | Online: {overview.stats.online} | Stale: {overview.stats.stale} | Offline: {overview.stats.offline}",
            f"Average health: {overview.average_health if overview.average_health is not None else 'N/A'} | Critical: {overview.critical} | Warning: {overview.warnings}",
            f"Needs OS updates: {overview.needs_updates} | Outdated agents: {overview.agents_outdated}",
            "",
            "ALERT ACTIVITY",
            f"Alerts in period: {counts.get('total', 0)} | Open in exported activity: {len(snapshot['open_alerts'])} | Critical: {counts.get('critical', 0)} | Warning: {counts.get('warning', 0)}",
            "",
            "DEVICE INVENTORY",
        ]
        for device in snapshot["devices"]:
            lines.append(
                f"{device.display_name or device.hostname} | {_value(device.status)} | {device.platform or 'windows'} | "
                f"{device.os_caption or device.os_name or 'Unknown OS'} | Agent {device.agent_version or 'unknown'} | "
                f"Last seen {device.last_seen:%Y-%m-%d %H:%M UTC}" if device.last_seen else
                f"{device.display_name or device.hostname} | {_value(device.status)} | {device.platform or 'windows'} | Never seen"
            )
        if snapshot["alerts"]:
            lines.extend(["", "RECENT ALERTS"])
            for alert in snapshot["alerts"][:100]:
                lines.append(
                    f"{alert.created_at:%Y-%m-%d} | {_value(alert.severity).upper()} | Device {alert.device_id} | {_value(alert.kind)} | {alert.message}"
                )
            if snapshot["alerts_truncated"]:
                lines.append(f"Detail is limited to the most recent {len(snapshot['alerts'])} alert rows; summary totals remain complete.")
        lines.extend(["", "Generated by TECHI Platform. Values reflect the fleet snapshot at generation time."])
        return _simple_pdf(lines)

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
