"""Numeric version comparison — the single, pure, dependency-free helper.

Both the component health derivation (``platform_core.components.derive_health``)
and the device version badge (``services.version_service.compare_versions``)
compare a reported/installed dotted-numeric version against a desired/latest one.
They previously each parsed versions into integer tuples and compared them
directly, which is wrong for versions of different segment counts:

    (1, 4, 6) < (1, 4, 6, 0)   # Python: shorter tuple sorts first

so ``1.4.6`` was flagged OUTDATED against ``1.4.6.0`` even though they are the
same semantic version. The fix is to treat missing trailing segments as zero by
zero-padding the shorter parse to equal length before comparing.

This module is intentionally pure (stdlib only) so the dependency-free domain
layer (``platform_core``) and the service layer can both import it without a
cycle, and so there is exactly one definition of "are these versions equal".
"""
from __future__ import annotations

from typing import Optional, Tuple


def parse_version(value: Optional[str]) -> Optional[Tuple[int, ...]]:
    """Parse a dot-separated all-numeric version into a tuple of ints.

    Returns None (never raises) when the value is empty or any segment is not a
    plain integer — callers use None to fail closed (e.g. prerelease strings like
    ``1.4.6-beta`` or build metadata like ``1.4.6+64`` are unparseable here).
    A leading ``v``/``V`` is tolerated (``v1.2`` == ``1.2``).
    """
    if value is None:
        return None
    text = value.strip().lstrip("vV")
    if text == "":
        return None
    try:
        return tuple(int(segment) for segment in text.split("."))
    except (ValueError, AttributeError):
        return None


def compare_numeric(left: Optional[str], right: Optional[str]) -> Optional[int]:
    """Compare two dotted-numeric versions, treating missing trailing segments
    as zero.

    Returns:
      * -1  when left  <  right
      *  0  when left ==  right   (including ``1.4.6`` vs ``1.4.6.0``)
      *  1  when left  >  right
      * None when either side is unparseable (caller decides how to fail closed).

    Examples: 1.4.6 == 1.4.6.0, 1.4 == 1.4.0.0, 1.4.6.1 > 1.4.6.0,
    2.1.20 > 2.1.19.9.
    """
    lv = parse_version(left)
    rv = parse_version(right)
    if lv is None or rv is None:
        return None
    width = max(len(lv), len(rv))
    lv = lv + (0,) * (width - len(lv))
    rv = rv + (0,) * (width - len(rv))
    if lv < rv:
        return -1
    return 1 if lv > rv else 0
