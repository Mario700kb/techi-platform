"""Shared numeric version comparison helper (platform_core.versioning).

Missing trailing segments are treated as zero, so versions of different segment
counts compare as equal when semantically equal (1.4.6 == 1.4.6.0).
"""
from app.platform_core.versioning import compare_numeric, parse_version


def test_parse_version_numeric_and_v_prefix():
    assert parse_version("1.4.6") == (1, 4, 6)
    assert parse_version("v2.1.19") == (2, 1, 19)
    assert parse_version(" 1.4 ") == (1, 4)


def test_parse_version_returns_none_for_unparseable():
    assert parse_version("") is None
    assert parse_version(None) is None
    assert parse_version("1.4.6-beta") is None
    assert parse_version("1.4.6+64") is None
    assert parse_version("dev-build") is None


def test_compare_numeric_equal_with_trailing_zero_padding():
    assert compare_numeric("1.4.6", "1.4.6.0") == 0
    assert compare_numeric("1.4.6.0", "1.4.6") == 0
    assert compare_numeric("1.4", "1.4.0.0") == 0
    assert compare_numeric("2.1.19", "2.1.19.0") == 0


def test_compare_numeric_less_and_greater():
    assert compare_numeric("1.4.5", "1.4.6.0") == -1
    assert compare_numeric("1.4.6.1", "1.4.6.0") == 1
    assert compare_numeric("2.1.20", "2.1.19.9") == 1
    assert compare_numeric("2.0", "1.9.9") == 1


def test_compare_numeric_none_when_unparseable():
    assert compare_numeric("1.4.6-beta", "1.4.6.0") is None
    assert compare_numeric("1.4.6", "abc") is None
    assert compare_numeric("", "1.4.6") is None
