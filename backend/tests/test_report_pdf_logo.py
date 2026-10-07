"""The TECHI logo is on every report PDF; a missing file must not break reports."""
from datetime import datetime

from app.services import report_pdf


def _render():
    report_pdf._logo.cache_clear()
    return report_pdf.render_report_pdf(
        scope="client", target="Udv", report_type="full",
        period_start=datetime(2026, 9, 7), period_end=datetime(2026, 10, 7),
        generated_at=datetime(2026, 10, 7, 9, 0), generated_by="mario",
        summary=[("Total devices", 1)],
        sections=[("Device Inventory", ["Hostname"], [["ARCH-05"]], "")],
    )


def test_logo_file_ships_with_the_backend():
    assert report_pdf.LOGO_PATH.is_file()


def test_pdf_contains_the_logo():
    assert b"/Subtype /Image" in _render()


def test_missing_logo_falls_back_to_text(monkeypatch, tmp_path):
    monkeypatch.setattr(report_pdf, "LOGO_PATH", tmp_path / "missing.png")
    pdf = _render()
    report_pdf._logo.cache_clear()
    assert b"/Subtype /Image" not in pdf
    assert pdf.startswith(b"%PDF")
