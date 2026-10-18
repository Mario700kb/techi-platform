"""PDF and CSV for any ReportDocument.

PDF: the TECHI Connect header/footer of report_pdf, a title block, the KPIs as
a row of tiles, then every section as a table (header row repeated on each
page, zebra rows, numbers right-aligned). The whole document turns landscape
when one of its sections has more than six columns. Readable in black and
white: tones are carried by bold text and the tile's top rule, never by
colour alone.

CSV: one file, the summary and then every section as a block (title row,
header row, rows, blank line). Numbers stay numbers; times are Tirana local.
"""
import csv
import io
from datetime import date, datetime
from html import escape
from typing import Optional

from reportlab.lib import colors
from reportlab.lib.enums import TA_RIGHT
from reportlab.lib.pagesizes import A4, landscape
from reportlab.lib.styles import ParagraphStyle
from reportlab.platypus import (
    BaseDocTemplate, CondPageBreak, Frame, KeepTogether, PageTemplate, Paragraph, Spacer, Table, TableStyle,
)

from app.core.time import format_display, to_display
from app.schemas.client_report import ReportColumn, ReportDocument
from app.services.client_reports.common import human_duration
from app.services.report_pdf import ACCENT, INK, LOGO_RATIO, MUTED, PALE, _logo

PDF_MAX_ROWS = 500
LINE = colors.HexColor("#D9E0E7")
TONE_COLORS = {
    "ok": colors.HexColor("#1E7F4F"), "warn": colors.HexColor("#B26A00"), "crit": colors.HexColor("#B42318"),
    "info": colors.HexColor("#2F6FB0"), "neutral": INK,
}


# ── values ──────────────────────────────────────────────────────────────────

def _parse_dt(value) -> Optional[datetime]:
    if isinstance(value, datetime):
        return value
    try:
        return datetime.fromisoformat(str(value))
    except ValueError:
        return None


def _parse_date(value) -> Optional[date]:
    if isinstance(value, date):
        return value
    try:
        return date.fromisoformat(str(value)[:10])
    except ValueError:
        return None


def _number(value) -> str:
    if isinstance(value, bool):
        return "Yes" if value else "No"
    if isinstance(value, int):
        return f"{value:,}".replace(",", " ")
    if isinstance(value, float):
        return f"{value:,.1f}".replace(",", " ").removesuffix(".0")
    return str(value)


def display(value, kind: str) -> str:
    """A value as a person reads it (PDF and KPI text)."""
    if value is None or value == "":
        return "—"
    if kind == "percent" and isinstance(value, (int, float)):
        return f"{value:.1f}".removesuffix(".0") + "%"
    if kind == "number":
        return _number(value)
    if kind == "duration" and isinstance(value, (int, float)):
        return human_duration(value)
    if kind == "date":
        day = _parse_date(value)
        return f"{day.day} {day:%b %Y}" if day else str(value)
    if kind == "datetime":
        dt = _parse_dt(value)
        return format_display(dt, "%d %b %Y %H:%M") if dt else str(value)
    return str(value)


def _csv_value(value, kind: str):
    if value is None:
        return ""
    if kind in ("number", "percent") and isinstance(value, (int, float)) and not isinstance(value, bool):
        return value
    if kind == "duration" and isinstance(value, (int, float)):
        seconds = int(value)
        return f"{seconds // 3600}:{seconds % 3600 // 60:02d}:{seconds % 60:02d}"
    if kind == "date":
        day = _parse_date(value)
        return day.isoformat() if day else _csv_text(value)
    if kind == "datetime":
        dt = _parse_dt(value)
        return to_display(dt).strftime("%Y-%m-%d %H:%M") if dt else _csv_text(value)
    return _csv_text(value)


def _csv_text(value) -> str:
    text = str(value)
    return "'" + text if text.lstrip().startswith(("=", "+", "-", "@")) else text


def _csv_label(column: ReportColumn) -> str:
    if column.kind == "percent" and "%" not in column.label:
        return f"{column.label} (%)"
    if column.kind == "duration":
        return f"{column.label} (h:mm:ss)"
    return column.label


def _period(doc: ReportDocument) -> str:
    return f"{format_display(doc.period_start, '%d %b %Y %H:%M')} – {format_display(doc.period_end, '%d %b %Y %H:%M %Z')}"


# ── CSV ─────────────────────────────────────────────────────────────────────

def render_document_csv(doc: ReportDocument, generated_by: str = "") -> bytes:
    output = io.StringIO(newline="")
    writer = csv.writer(output)
    writer.writerow([f"TECHI {doc.title}", _csv_text(doc.client_name)])
    writer.writerow(["Period", to_display(doc.period_start).strftime("%Y-%m-%d %H:%M"),
                     to_display(doc.period_end).strftime("%Y-%m-%d %H:%M")])
    writer.writerow(["Generated", to_display(doc.generated_at).strftime("%Y-%m-%d %H:%M"), _csv_text(generated_by)])
    if doc.subtitle:
        writer.writerow([_csv_text(doc.subtitle)])
    writer.writerow([])
    writer.writerow(["Summary"])
    writer.writerow(["Measure", "Value", "Note"])
    for kpi in doc.summary:
        writer.writerow([_csv_text(kpi.label), display(kpi.value, kpi.kind), _csv_text(kpi.hint or "")])
    writer.writerow([])
    for section in doc.sections:
        writer.writerow([_csv_text(section.title)])
        writer.writerow([_csv_label(c) for c in section.columns])
        if not section.rows:
            writer.writerow([_csv_text(section.empty)])
        for row in section.rows:
            writer.writerow([_csv_value(row.get(c.key), c.kind) for c in section.columns])
        if section.note:
            writer.writerow([_csv_text(section.note)])
        writer.writerow([])
    if doc.notes:
        writer.writerow(["Notes"])
        for note in doc.notes:
            writer.writerow([_csv_text(note)])
    return output.getvalue().encode("utf-8-sig")


# ── PDF ─────────────────────────────────────────────────────────────────────

def _styles() -> dict:
    return {
        "eyebrow": ParagraphStyle("eyebrow", fontName="Helvetica-Bold", fontSize=9, leading=13, textColor=ACCENT),
        "title": ParagraphStyle("title", fontName="Helvetica-Bold", fontSize=22, leading=27, textColor=INK),
        "subtitle": ParagraphStyle("subtitle", fontName="Helvetica", fontSize=11.5, leading=16, textColor=MUTED),
        "meta": ParagraphStyle("meta", fontName="Helvetica", fontSize=8, leading=11, textColor=MUTED),
        "heading": ParagraphStyle("heading", fontName="Helvetica-Bold", fontSize=13.5, leading=18, textColor=INK,
                                  spaceBefore=6, spaceAfter=3),
        "desc": ParagraphStyle("desc", fontName="Helvetica", fontSize=8.5, leading=12, textColor=MUTED, spaceAfter=6),
        "note": ParagraphStyle("note", fontName="Helvetica-Oblique", fontSize=7.5, leading=10.5, textColor=MUTED, spaceBefore=4),
        "empty": ParagraphStyle("empty", fontName="Helvetica-Oblique", fontSize=9, leading=13, textColor=MUTED),
        "body": ParagraphStyle("body", fontName="Helvetica", fontSize=9, leading=13, textColor=INK),
        "cell": ParagraphStyle("cell", fontName="Helvetica", fontSize=7.8, leading=10.2, textColor=INK),
        "cell_r": ParagraphStyle("cell_r", fontName="Helvetica", fontSize=7.8, leading=10.2, textColor=INK, alignment=TA_RIGHT),
        "head": ParagraphStyle("head", fontName="Helvetica-Bold", fontSize=7.8, leading=10.2, textColor=colors.white),
        "head_r": ParagraphStyle("head_r", fontName="Helvetica-Bold", fontSize=7.8, leading=10.2, textColor=colors.white,
                                 alignment=TA_RIGHT),
        "kpi_value": ParagraphStyle("kpi_value", fontName="Helvetica-Bold", fontSize=17, leading=21, textColor=INK),
        "kpi_label": ParagraphStyle("kpi_label", fontName="Helvetica-Bold", fontSize=8, leading=10.5, textColor=INK),
        "kpi_hint": ParagraphStyle("kpi_hint", fontName="Helvetica", fontSize=7, leading=9.5, textColor=MUTED),
    }


def _p(text, style, color=None, bold=False) -> Paragraph:
    body = escape(str(text)).replace("\n", "<br/>")
    if bold:
        body = f"<b>{body}</b>"
    if color is not None:
        body = f'<font color="{color.hexval()}">{body}</font>'
    return Paragraph(body, style)


def _kpi_tiles(summary: list, width: float, styles: dict) -> Optional[Table]:
    if not summary:
        return None
    gap = 6
    count = len(summary)
    tile_w = (width - gap * (count - 1)) / count
    value_style = styles["kpi_value"]
    if count >= 5 or any(len(display(k.value, k.kind)) > 9 for k in summary):
        value_style = ParagraphStyle("kpi_value_s", parent=value_style, fontSize=13, leading=17)
    cells, widths = [], []
    for index, kpi in enumerate(summary):
        cells.append([_p(display(kpi.value, kpi.kind), value_style, TONE_COLORS.get(kpi.tone)),
                      _p(kpi.label, styles["kpi_label"]),
                      *([_p(kpi.hint, styles["kpi_hint"])] if kpi.hint else [])])
        widths.append(tile_w)
        if index < count - 1:
            cells.append("")
            widths.append(gap)
    table = Table([cells], colWidths=widths, hAlign="LEFT")
    commands = [("VALIGN", (0, 0), (-1, -1), "TOP"), ("TOPPADDING", (0, 0), (-1, -1), 8),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 9), ("LEFTPADDING", (0, 0), (-1, -1), 8),
                ("RIGHTPADDING", (0, 0), (-1, -1), 6)]
    for index, kpi in enumerate(summary):
        column = index * 2
        commands += [("BACKGROUND", (column, 0), (column, 0), PALE),
                     ("LINEABOVE", (column, 0), (column, 0), 2.5, TONE_COLORS.get(kpi.tone, INK))]
    for column in range(1, len(cells), 2):
        commands += [("LEFTPADDING", (column, 0), (column, 0), 0), ("RIGHTPADDING", (column, 0), (column, 0), 0)]
    table.setStyle(TableStyle(commands))
    return table


def _column_widths(columns: list, rows: list, width: float) -> list:
    weights = []
    for column in columns:
        lengths = sorted(len(display(row.get(column.key), column.kind)) for row in rows[:200])
        typical = lengths[int(len(lengths) * 0.8)] if lengths else 0
        weights.append(max(5, min(48, max(len(column.label) * 0.9, typical))))
    total = sum(weights)
    return [width * w / total for w in weights]


def _section_table(section, width: float, styles: dict) -> Table:
    rows = section.rows[:PDF_MAX_ROWS]
    right = [c.align == "right" for c in section.columns]
    data = [[_p(c.label, styles["head_r" if r else "head"]) for c, r in zip(section.columns, right)]]
    for row in rows:
        tone = TONE_COLORS.get(row.get("_tone") or "", None)
        cells = []
        for column, is_right in zip(section.columns, right):
            text = display(row.get(column.key), column.kind)
            style = styles["cell_r" if is_right else "cell"]
            if column.kind == "badge" and text != "—":
                cells.append(_p(text, style, tone, bold=True))
            else:
                cells.append(_p(text, style))
        data.append(cells)
    table = Table(data, colWidths=_column_widths(section.columns, rows, width), repeatRows=1, hAlign="LEFT")
    table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), INK),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, PALE]),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("TOPPADDING", (0, 0), (-1, -1), 4.5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 4.5),
        ("LEFTPADDING", (0, 0), (-1, -1), 5),
        ("RIGHTPADDING", (0, 0), (-1, -1), 5),
        ("LINEBELOW", (0, 1), (-1, -1), 0.25, LINE),
    ]))
    return table


def render_document_pdf(doc: ReportDocument, generated_by: str) -> bytes:
    output = io.BytesIO()
    wide = any(len(section.columns) > 6 for section in doc.sections)
    page_w, page_h = landscape(A4) if wide else A4
    margin = 42
    content_w = page_w - 2 * margin
    styles = _styles()

    def draw_page(canvas, document):
        canvas.saveState()
        canvas.setStrokeColor(ACCENT)
        canvas.setLineWidth(2)
        canvas.line(margin, page_h - 45, page_w - margin, page_h - 45)
        logo = _logo()
        if logo is not None:
            canvas.drawImage(logo, margin, page_h - 40, width=16 * LOGO_RATIO, height=16, mask="auto")
        else:
            canvas.setFont("Helvetica-Bold", 8)
            canvas.setFillColor(INK)
            canvas.drawString(margin, page_h - 34, "TECHI CONNECT")
        canvas.setFont("Helvetica-Bold", 8)
        canvas.setFillColor(MUTED)
        canvas.drawRightString(page_w - margin, page_h - 34, f"{doc.title.upper()}  ·  {doc.client_name}"[:90])
        canvas.setStrokeColor(LINE)
        canvas.setLineWidth(0.5)
        canvas.line(margin, 48, page_w - margin, 48)
        canvas.setFont("Helvetica", 7)
        canvas.setFillColor(MUTED)
        canvas.drawString(margin, 35, f"Generated {format_display(doc.generated_at)}  |  {generated_by}"[:110])
        canvas.drawRightString(page_w - margin, 35, f"Page {document.page}")
        canvas.restoreState()

    frame = Frame(margin, 64, content_w, page_h - 126, leftPadding=0, rightPadding=0, topPadding=0, bottomPadding=0)
    template = BaseDocTemplate(
        output, pagesize=(page_w, page_h), pageCompression=0,
        pageTemplates=[PageTemplate(id="report", frames=frame, onPage=draw_page)],
        title=f"TECHI {doc.title} — {doc.client_name}", author="TECHI Connect",
    )
    story = [Spacer(1, 6)]
    story += [
        _p("CLIENT REPORT", styles["eyebrow"]), Spacer(1, 4),
        _p(doc.title, styles["title"]), Spacer(1, 4),
        _p(f"{doc.client_name}  ·  {_period(doc)}", styles["subtitle"]),
    ]
    if doc.subtitle:
        story.append(_p(doc.subtitle, styles["meta"]))
    story += [_p(f"Generated {format_display(doc.generated_at)} by {generated_by}", styles["meta"]), Spacer(1, 14)]
    tiles = _kpi_tiles(doc.summary, content_w, styles)
    if tiles is not None:
        story += [tiles, Spacer(1, 6)]
    for section in doc.sections:
        head = [Spacer(1, 10), _p(section.title, styles["heading"])]
        if section.description:
            head.append(_p(section.description, styles["desc"]))
        story.append(CondPageBreak(110))
        if not section.rows:
            story.append(KeepTogether([*head, _p(section.empty, styles["empty"])]))
        else:
            story.append(KeepTogether(head))
            story.append(_section_table(section, content_w, styles))
            if len(section.rows) > PDF_MAX_ROWS:
                story.append(_p(f"Showing the first {PDF_MAX_ROWS} of {len(section.rows)} rows; the CSV export has all of them.",
                                styles["note"]))
        if section.note:
            story.append(_p(section.note, styles["note"]))
    if doc.notes:
        story += [CondPageBreak(80), Spacer(1, 12), _p("Notes", styles["heading"])]
        story += [_p(f"•  {note}", styles["desc"]) for note in doc.notes]
    template.build(story)
    return output.getvalue()

