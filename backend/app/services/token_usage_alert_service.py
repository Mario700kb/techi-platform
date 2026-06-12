"""Synthetic, computed-on-read alerts for enrollment token usage.

Tokens nearing or at max_uses surface in the alerts feed and badge count
without a background job or a dedicated table: the token count is tiny
(~tens of rows), so the check runs on every alerts read. Synthetic alerts
use negative ids (-token_id) so they can never collide with device_alerts
rows, and they disappear on their own once max_uses is raised.
"""

from typing import Dict, List

from sqlalchemy.orm import Session

from app.core.time import utcnow
from app.models.enrollment_token import EnrollmentToken, EnrollmentTokenStatus


def build_token_usage_alerts(db: Session) -> List[Dict]:
    tokens = (
        db.query(EnrollmentToken)
        .filter(
            EnrollmentToken.is_internal.is_(False),
            EnrollmentToken.status.in_(
                [EnrollmentTokenStatus.ACTIVE.value, EnrollmentTokenStatus.USED.value]
            ),
        )
        .all()
    )
    alerts: List[Dict] = []
    for token in tokens:
        warning = token.usage_warning
        if not warning:
            continue
        percent = round(100 * (token.use_count or 0) / token.max_uses)
        timestamp = token.used_at or token.created_at or utcnow()
        alerts.append(
            {
                "id": -token.id,
                "device_id": None,
                "token_id": token.id,
                "kind": f"token_usage_{warning}",
                "severity": warning,
                "state": "open",
                "message": (
                    f"{token.name} enrollment token at {token.use_count}/{token.max_uses}"
                    f" ({percent}%) — consider increasing max_uses"
                ),
                "detail": None,
                "created_at": timestamp,
                "updated_at": timestamp,
            }
        )
    alerts.sort(key=lambda a: (a["severity"] != "critical", a["message"]))
    return alerts
