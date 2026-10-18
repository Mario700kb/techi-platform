"""Build a client report by key."""
from datetime import datetime
from typing import Optional

from sqlalchemy.orm import Session

from app.schemas.client_report import ReportDocument
from app.services.client_reports import access, availability, capacity, executive, lifecycle, patch, security
from app.services.client_reports.common import ReportContext

BUILDERS = {module.KEY: module.build for module in (executive, patch, lifecycle, availability, capacity, access, security)}


def build_report(db: Session, report_type: str, *, client_id: int, client_name: str, start: datetime, end: datetime,
                 now: Optional[datetime] = None) -> ReportDocument:
    builder = BUILDERS.get(report_type)
    if builder is None:
        raise ValueError(f"No document builder for report type {report_type!r}")
    ctx = ReportContext(db, client_id=client_id, client_name=client_name, start=start, end=end, now=now)
    return builder(ctx).document
