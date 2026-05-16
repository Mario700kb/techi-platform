import logging
from dataclasses import dataclass
from typing import Optional

from sqlalchemy.orm import Session

from app.models.device import Device

logger = logging.getLogger(__name__)

# Weights for each identity field. Higher weight = stronger signal.
_FIELD_WEIGHTS: dict[str, int] = {
    "rustdesk_id": 30,
    "hostname": 22,
    "local_ip": 18,
    "cpu": 10,
    "public_ip": 8,
    "os_name": 6,
    "domain": 6,
    "ram": 5,
    "storage": 4,
    "platform": 3,
    "current_user": 2,
}

# Deterministic, single-tier thresholds applied uniformly across all device types.
# Domain-joined vs workgroup distinction is handled by the caller's safety gate,
# not by varying the threshold here.
THRESHOLD_HIGH = 0.90     # >= 0.90 → eligible for automatic device reuse
THRESHOLD_MEDIUM = 0.70   # 0.70–0.89 → mark as duplicate_candidate only
# < 0.70 → create a fresh device, no duplicate marking


@dataclass
class FingerprintMatch:
    device: Optional[Device]
    score: float            # normalized 0.0–1.0
    confidence: str         # "high" | "medium" | "none"


def _normalize(value: Optional[str]) -> Optional[str]:
    if not value:
        return None
    stripped = value.strip().lower()
    return stripped if stripped else None


def _score_pair(device: Device, data: dict) -> float:
    """
    Compute similarity score (0.0–1.0) between an existing device and incoming data dict.

    Only counts fields where at least one side has a value. Fields where both sides
    are None/empty are excluded from the denominator, keeping the score meaningful
    even for sparsely populated devices.
    """
    total_weight = 0
    matched_weight = 0

    for field, weight in _FIELD_WEIGHTS.items():
        existing_val = _normalize(getattr(device, field, None))
        incoming_val = _normalize(data.get(field))

        if existing_val is None and incoming_val is None:
            continue  # neither side has data — exclude from scoring

        total_weight += weight

        if existing_val is not None and incoming_val is not None and existing_val == incoming_val:
            matched_weight += weight

    if total_weight == 0:
        return 0.0

    return matched_weight / total_weight


class DeviceFingerprintService:
    def __init__(self, db: Session):
        self.db = db

    def find_best_match(self, data: dict, exclude_rustdesk_id: Optional[str] = None) -> FingerprintMatch:
        """
        Search all existing devices (including archived) for the best fingerprint match.

        Pre-filters candidates to those sharing at least one strong anchor field
        (hostname, local_ip, cpu, or public_ip) to avoid full-table O(n) scoring
        on large fleets.

        Confidence levels:
          - "high"   score >= 0.90  (eligible for auto-reuse, subject to caller safety gate)
          - "medium" score >= 0.70  (mark as duplicate_candidate only)
          - "none"   score <  0.70  (create new device, no duplicate marking)
        """
        hostname = _normalize(data.get("hostname"))
        local_ip = _normalize(data.get("local_ip"))
        cpu = _normalize(data.get("cpu"))
        public_ip = _normalize(data.get("public_ip"))

        from sqlalchemy import or_
        conditions = []
        if hostname:
            conditions.append(Device.hostname.ilike(hostname))
        if local_ip:
            conditions.append(Device.local_ip == local_ip)
        if cpu:
            conditions.append(Device.cpu.ilike(cpu))
        if public_ip:
            conditions.append(Device.public_ip == public_ip)

        if not conditions:
            return FingerprintMatch(device=None, score=0.0, confidence="none")

        query = self.db.query(Device).filter(or_(*conditions))
        if exclude_rustdesk_id:
            query = query.filter(Device.rustdesk_id != exclude_rustdesk_id)

        candidates = query.all()
        if not candidates:
            return FingerprintMatch(device=None, score=0.0, confidence="none")

        best_device: Optional[Device] = None
        best_score = 0.0

        for candidate in candidates:
            score = _score_pair(candidate, data)
            if score > best_score:
                best_score = score
                best_device = candidate

        if best_device is None or best_score < THRESHOLD_MEDIUM:
            return FingerprintMatch(device=None, score=best_score, confidence="none")

        confidence = "high" if best_score >= THRESHOLD_HIGH else "medium"

        logger.info(
            "[fingerprint] match found: score=%.2f confidence=%s matched_device_id=%d incoming_rustdesk_id=%s",
            best_score,
            confidence,
            best_device.id,
            data.get("rustdesk_id", "unknown"),
        )

        return FingerprintMatch(device=best_device, score=best_score, confidence=confidence)

    def scan_all_duplicates(self) -> list[tuple[Device, Device, float]]:
        """
        Full fleet scan for duplicate pairs. Used for batch duplicate detection.
        Returns list of (device_a, device_b, score) sorted by score descending.
        Only pairs meeting THRESHOLD_MEDIUM are included.
        """
        devices = self.db.query(Device).all()
        pairs: list[tuple[Device, Device, float]] = []

        for i, a in enumerate(devices):
            a_data = {field: getattr(a, field, None) for field in _FIELD_WEIGHTS}
            for b in devices[i + 1:]:
                score = _score_pair(b, a_data)
                if score >= THRESHOLD_MEDIUM:
                    pairs.append((a, b, score))

        pairs.sort(key=lambda t: t[2], reverse=True)
        return pairs
