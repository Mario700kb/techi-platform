"""Human-readable times are Tirana time; storage stays UTC."""
from datetime import datetime, timezone

from app.core.time import format_display, to_display


def test_summer_time_is_utc_plus_two():
    # Naive values come straight from the DB and are UTC.
    assert format_display(datetime(2026, 10, 5, 12, 52)) == "2026-10-05 14:52 CEST"


def test_winter_time_is_utc_plus_one():
    assert format_display(datetime(2026, 1, 15, 12, 52, tzinfo=timezone.utc)) == "2026-01-15 13:52 CET"


def test_csv_iso_carries_the_offset():
    assert to_display(datetime(2026, 10, 5, 12, 52)).isoformat() == "2026-10-05T14:52:00+02:00"


def test_missing_value_stays_empty():
    assert to_display(None) is None
    assert format_display(None) == ""
