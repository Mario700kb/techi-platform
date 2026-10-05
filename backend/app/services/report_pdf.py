"""PDF layout shared by client and device reports."""

import io
from datetime import datetime
from html import escape

from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.platypus import (
    BaseDocTemplate, CondPageBreak, Frame, KeepTogether, PageBreak, PageTemplate,
    Paragraph, Spacer, Table, TableStyle,
)

from app.core.time import format_display
from app.services.report_output import safe_text


INK = colors.HexColor("#17243A")
MUTED = colors.HexColor("#5F6C7B")
ACCENT = colors.HexColor("#E87722")
PALE = colors.HexColor("#F2F5F8")


def _p(value, style):
    return Paragraph(escape(safe_text(value)).replace("\n", "<br/>"), style)


def render_report_pdf(*, scope: str, target: str, report_type: str,
                      period_start: datetime, period_end: datetime,
                      generated_at: datetime, generated_by: str,
                      summary: list, sections: list) -> bytes:
    """Render a cover, summary and paginated section tables to a stored PDF."""
    output = io.BytesIO()
    page_w, page_h = A4
    styles = {
        "eyebrow": ParagraphStyle("eyebrow", fontName="Helvetica-Bold", fontSize=10, leading=15, textColor=ACCENT),
        "title": ParagraphStyle("title", fontName="Helvetica-Bold", fontSize=30, leading=36, textColor=INK),
        "subtitle": ParagraphStyle("subtitle", fontName="Helvetica", fontSize=15, leading=21, textColor=MUTED),
        "heading": ParagraphStyle("heading", fontName="Helvetica-Bold", fontSize=16, leading=21, textColor=INK, spaceBefore=14, spaceAfter=9),
        "body": ParagraphStyle("body", fontName="Helvetica", fontSize=9, leading=13, textColor=INK),
        "small": ParagraphStyle("small", fontName="Helvetica", fontSize=8, leading=11, textColor=MUTED),
        "cell": ParagraphStyle("cell", fontName="Helvetica", fontSize=7.2, leading=10, textColor=INK),
        "headcell": ParagraphStyle("headcell", fontName="Helvetica-Bold", fontSize=7.2, leading=10, textColor=colors.white),
    }

    def draw_page(canvas, doc):
        canvas.saveState()
        canvas.setStrokeColor(ACCENT)
        canvas.setLineWidth(2)
        canvas.line(42, page_h - 45, page_w - 42, page_h - 45)
        canvas.setFont("Helvetica-Bold", 8)
        canvas.setFillColor(INK)
        canvas.drawString(42, page_h - 34, "TECHI PLATFORM  /  REPORTS")
        canvas.setStrokeColor(colors.HexColor("#D9E0E7"))
        canvas.setLineWidth(0.5)
        canvas.line(42, 48, page_w - 42, 48)
        canvas.setFont("Helvetica", 7)
        canvas.setFillColor(MUTED)
        footer = f"Generated {format_display(generated_at)}  |  Operator: {safe_text(generated_by)}"
        canvas.drawString(42, 35, footer[:94])
        canvas.drawRightString(page_w - 42, 35, f"Page {doc.page}")
        canvas.restoreState()

    frame = Frame(42, 64, page_w - 84, page_h - 126, leftPadding=0, rightPadding=0,
                  topPadding=0, bottomPadding=0)
    doc = BaseDocTemplate(output, pagesize=A4, pageCompression=0,
                          pageTemplates=[PageTemplate(id="report", frames=frame, onPage=draw_page)],
                          title=f"TECHI {scope.title()} {report_type} Report", author="TECHI Platform")
    story = [Spacer(1, 95), _p("TECHI PLATFORM  /  REPORTS", styles["eyebrow"]), Spacer(1, 16),
             _p(f"{report_type.replace('_', ' ').title()} Report", styles["title"]), Spacer(1, 12),
             _p(f"{scope.title()}: {target}", styles["subtitle"]), Spacer(1, 35)]
    cover_rows = [
        ("Reporting period", f"{format_display(period_start)} to {format_display(period_end)}"),
        ("Generated", format_display(generated_at)),
        ("Operator", generated_by),
        ("Format", "PDF"),
    ]
    cover = Table([[_p(a, styles["small"]), _p(b, styles["body"])] for a, b in cover_rows],
                  colWidths=[120, page_w - 204], hAlign="LEFT")
    cover.setStyle(TableStyle([("BACKGROUND", (0, 0), (-1, -1), PALE),
                               ("BOTTOMPADDING", (0, 0), (-1, -1), 11),
                               ("TOPPADDING", (0, 0), (-1, -1), 11),
                               ("LEFTPADDING", (0, 0), (-1, -1), 12)]))
    story.extend([cover, PageBreak(), _p("Executive Summary", styles["heading"])])
    summary_rows = [[_p(label, styles["body"]), _p(value, styles["body"])] for label, value in summary]
    if summary_rows:
        summary_table = Table(summary_rows, colWidths=[165, page_w - 249], hAlign="LEFT")
        summary_table.setStyle(TableStyle([("ROWBACKGROUNDS", (0, 0), (-1, -1), [PALE, colors.white]),
                                           ("VALIGN", (0, 0), (-1, -1), "TOP"),
                                           ("TOPPADDING", (0, 0), (-1, -1), 8),
                                           ("BOTTOMPADDING", (0, 0), (-1, -1), 8)]))
        story.append(summary_table)
    for title, headers, rows, note in sections:
        heading = _p(title, styles["heading"])
        story.append(CondPageBreak(145))
        story.append(KeepTogether([Spacer(1, 14), heading, _p(note, styles["small"]) if note else Spacer(1, 1)]))
        if not rows:
            story.append(_p("No available records.", styles["body"]))
            continue
        width = (page_w - 84) / len(headers)
        data = [[_p(item, styles["headcell"]) for item in headers]]
        data += [[_p(cell, styles["cell"]) for cell in row] for row in rows]
        table = Table(data, colWidths=[width] * len(headers), repeatRows=1, hAlign="LEFT")
        table.setStyle(TableStyle([
            ("BACKGROUND", (0, 0), (-1, 0), INK),
            ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, PALE]),
            ("VALIGN", (0, 0), (-1, -1), "TOP"),
            ("TOPPADDING", (0, 0), (-1, -1), 6),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
            ("LEFTPADDING", (0, 0), (-1, -1), 5),
            ("RIGHTPADDING", (0, 0), (-1, -1), 5),
            ("LINEBELOW", (0, -1), (-1, -1), 0.4, colors.HexColor("#D9E0E7")),
        ]))
        story.append(table)
    doc.build(story)
    return output.getvalue()
