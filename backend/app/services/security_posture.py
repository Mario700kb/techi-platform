"""Reading a device's security posture: what is wrong, and a 0–100 score.

The score starts at 100 and loses, once each:

    no active antivirus (Defender off/absent and no third-party AV)  −35
    Defender real-time protection off                                −20
    Defender signatures older than 7 days                            −10
    firewall off on any profile (domain, private or public)          −15
    BitLocker off on the system drive                                −10
    UAC off                                                           −5
    Secure Boot off                                                   −5

A probe the agent could not read (null / "unknown") never costs points: the
score reflects what is known to be wrong. The real-time and signature checks
apply only while Defender is the active antivirus — with a third-party product
Defender is passive and its own settings say nothing — and not on top of
"no active antivirus".
"""
from __future__ import annotations

from typing import Any, Mapping, Optional, Union

from app.schemas.security_posture import SecurityPosture

PostureInput = Union[SecurityPosture, Mapping[str, Any]]

WEIGHT_NO_ANTIVIRUS = 35
WEIGHT_REALTIME_OFF = 20
WEIGHT_SIGNATURES_STALE = 10
WEIGHT_FIREWALL_OFF = 15
WEIGHT_BITLOCKER_OFF = 10
WEIGHT_UAC_OFF = 5
WEIGHT_SECURE_BOOT_OFF = 5

SIGNATURE_MAX_AGE_DAYS = 7

# (code, weight) in the order issues are listed; codes are stable for callers
# that want their own wording or translations.
POSTURE_WEIGHTS: dict[str, int] = {
    "no_antivirus": WEIGHT_NO_ANTIVIRUS,
    "realtime_off": WEIGHT_REALTIME_OFF,
    "signatures_stale": WEIGHT_SIGNATURES_STALE,
    "firewall_off": WEIGHT_FIREWALL_OFF,
    "bitlocker_off": WEIGHT_BITLOCKER_OFF,
    "uac_off": WEIGHT_UAC_OFF,
    "secure_boot_off": WEIGHT_SECURE_BOOT_OFF,
}


def _coerce(posture: PostureInput) -> SecurityPosture:
    if isinstance(posture, SecurityPosture):
        return posture
    return SecurityPosture.model_validate(dict(posture))


def defender_active(posture: SecurityPosture) -> bool:
    """Defender is present and not known to be switched off."""
    return posture.defender.present and posture.defender.antivirus_enabled is not False


def has_antivirus(posture: SecurityPosture) -> bool:
    return defender_active(posture) or bool(posture.third_party_av)


def posture_findings(posture: PostureInput) -> list[tuple[str, str]]:
    """(code, message) for each problem, in POSTURE_WEIGHTS order."""
    p = _coerce(posture)
    findings: list[tuple[str, str]] = []
    if not has_antivirus(p):
        findings.append(("no_antivirus", "No active antivirus"))
    elif defender_active(p) and not p.third_party_av:
        if p.defender.realtime_enabled is False:
            findings.append(("realtime_off", "Defender real-time protection is off"))
        age = p.defender.signature_age_days
        if age is not None and age > SIGNATURE_MAX_AGE_DAYS:
            findings.append(("signatures_stale", f"Antivirus signatures are {age} days old"))
    off = [name for name in ("domain", "private", "public") if getattr(p.firewall, name) is False]
    if off:
        findings.append(("firewall_off", f"Firewall off: {', '.join(off)}"))
    if p.bitlocker.protection == "off":
        findings.append(("bitlocker_off", f"BitLocker is off on {p.bitlocker.system_drive}"))
    if p.uac_enabled is False:
        findings.append(("uac_off", "UAC is off"))
    if p.secure_boot is False:
        findings.append(("secure_boot_off", "Secure Boot is off"))
    return findings


def posture_issues(posture: PostureInput) -> list[str]:
    """Human-readable problems, most serious first; [] when nothing is known wrong."""
    return [message for _, message in posture_findings(posture)]


def posture_score(posture: PostureInput) -> int:
    """0–100, 100 = nothing known to be wrong (weights in the module docstring)."""
    lost = sum(POSTURE_WEIGHTS[code] for code, _ in posture_findings(posture))
    return max(0, 100 - lost)


def posture_from_json(raw_json: Optional[str]) -> Optional[SecurityPosture]:
    """device_inventory.security_json → SecurityPosture (None when absent or unreadable)."""
    if not raw_json:
        return None
    try:
        return SecurityPosture.model_validate_json(raw_json)
    except ValueError:
        return None
