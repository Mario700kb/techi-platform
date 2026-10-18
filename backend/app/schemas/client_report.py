"""The uniform document every client report builder returns.

One shape serves the preview page (JSON), the PDF and the CSV, so the three
never disagree. Values are JSON-native: numbers stay numbers, percentages are
0–100, durations are seconds, dates are "YYYY-MM-DD" and datetimes ISO 8601 in
UTC; the reader formats them (PDF/CSV in Tirana local time).
"""
from datetime import datetime
from typing import Any, Dict, List, Literal, Optional, Union

from pydantic import BaseModel, Field

Tone = Literal["ok", "warn", "crit", "info", "neutral"]
Align = Literal["left", "right"]
ColumnKind = Literal["text", "number", "percent", "date", "datetime", "duration", "badge"]
KpiKind = Literal["number", "percent", "duration", "text"]


class ReportKpi(BaseModel):
    label: str
    value: Union[int, float, str, None] = None
    # How to format `value`; "text" values are already display-ready.
    kind: KpiKind = "number"
    hint: Optional[str] = None
    tone: Tone = "neutral"


class ReportColumn(BaseModel):
    key: str
    label: str
    align: Align = "left"
    kind: ColumnKind = "text"


class ReportSection(BaseModel):
    key: str
    title: str
    description: Optional[str] = None
    columns: List[ReportColumn]
    # {<column key>: value, "_tone": optional tone, "_device_id": optional int}
    rows: List[Dict[str, Any]] = Field(default_factory=list)
    empty: str = "Nothing to report."
    note: Optional[str] = None


class ReportDocument(BaseModel):
    key: str
    title: str
    subtitle: Optional[str] = None
    client_id: int
    client_name: str
    period_start: datetime
    period_end: datetime
    generated_at: datetime
    summary: List[ReportKpi] = Field(default_factory=list)
    sections: List[ReportSection] = Field(default_factory=list)
    notes: List[str] = Field(default_factory=list)


class ReportCatalogItem(BaseModel):
    key: str
    title: str
    description: str
    formats: List[Literal["pdf", "csv"]]
    needs: Optional[str] = None  # e.g. "agent 2.1.31": the data comes only from agents from that version
    preview: bool = True  # False: no JSON preview (the original "full" report renders only to files)
