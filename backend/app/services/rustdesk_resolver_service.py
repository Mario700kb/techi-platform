import logging
import os
import re
import sqlite3
import time
from dataclasses import dataclass
from typing import List, Optional

from app.core.config import settings

logger = logging.getLogger(__name__)

_RECENT_THRESHOLD_SECONDS = 86400  # 24 hours

# Columns RustDesk may use for the peer's last-seen IP (schema varies by version)
_IP_COLUMN_CANDIDATES = ("last_ip", "ip_address", "ip", "last_seen_ip", "info")
# Columns RustDesk may use for the peer's last-seen timestamp
_TIMESTAMP_COLUMN_CANDIDATES = ("last_online", "updated_at", "last_seen", "modified_at")

# RustDesk IDs that must never be stored as real IDs
_PLACEHOLDER_IDS = frozenset({"rustdesk-placeholder", "unknown", "unset", "none"})
_INVALID_PREFIXES = ("agent_", "pending_")


def _is_valid_rustdesk_id(peer_id: str) -> bool:
    """Return False if peer_id looks like an internal placeholder or agent-generated value."""
    if not peer_id:
        return False
    lower = peer_id.strip().lower()
    if lower in _PLACEHOLDER_IDS:
        return False
    for prefix in _INVALID_PREFIXES:
        if lower.startswith(prefix):
            return False
    return bool(re.match(r"^[A-Za-z0-9_-]{6,64}$", peer_id.strip()))


@dataclass
class ResolverResult:
    rustdesk_id: Optional[str]
    confidence: str  # "high" | "medium" | "low" | "none"
    message: str


class RustDeskResolverService:
    """Optional server-side resolver that looks up real RustDesk IDs from
    the RustDesk server's SQLite peer database (db_v2.sqlite3).

    Disabled gracefully when RUSTDESK_RESOLVER_ENABLED=false or the DB is
    missing — heartbeat processing always continues without it.

    Confidence levels:
      high   — unique hostname match + peer seen within 24 h → safe to auto-update
               (or multiple hostname matches disambiguated by IP → single winner)
      medium — unique hostname match but peer is stale/old → do not auto-update
      low    — multiple peers share the same hostname and IP cannot disambiguate
      none   — no match, resolver disabled, or DB unavailable
    """

    @classmethod
    def is_enabled(cls) -> bool:
        return bool(settings.RUSTDESK_RESOLVER_ENABLED and settings.RUSTDESK_SERVER_DB_PATH)

    @classmethod
    def resolve(
        cls,
        *,
        hostname: Optional[str],
        local_ip: Optional[str] = None,
        public_ip: Optional[str] = None,
    ) -> ResolverResult:
        if not cls.is_enabled():
            return ResolverResult(None, "none", "Resolver disabled")

        db_path = settings.RUSTDESK_SERVER_DB_PATH
        try:
            return cls._resolve(db_path, hostname=hostname, local_ip=local_ip, public_ip=public_ip)
        except Exception as exc:
            logger.warning("[rustdesk_resolver] unexpected error: %s", exc, exc_info=True)
            return ResolverResult(None, "none", f"Resolver error: {exc}")

    @classmethod
    def _resolve(
        cls,
        db_path: str,
        *,
        hostname: Optional[str],
        local_ip: Optional[str],
        public_ip: Optional[str],
    ) -> ResolverResult:
        if not os.path.exists(db_path):
            logger.debug("[rustdesk_resolver] DB not found at %s", db_path)
            return ResolverResult(None, "none", "TECHI Remote Support server DB not found")

        if not hostname:
            return ResolverResult(None, "none", "No hostname to match")

        conn = sqlite3.connect(db_path, timeout=5, check_same_thread=False)
        try:
            conn.row_factory = sqlite3.Row
            return cls._query(conn, hostname=hostname, local_ip=local_ip, public_ip=public_ip)
        finally:
            conn.close()

    @classmethod
    def _query(
        cls,
        conn: sqlite3.Connection,
        *,
        hostname: str,
        local_ip: Optional[str],
        public_ip: Optional[str],
    ) -> ResolverResult:
        cursor = conn.execute("PRAGMA table_info(peers)")
        columns = {row[1].lower() for row in cursor.fetchall()}

        if not columns:
            return ResolverResult(None, "none", "TECHI Remote Support peers table not found or empty schema")

        if "hostname" not in columns:
            return ResolverResult(None, "none", "TECHI Remote Support peers table has no hostname column")

        # Discover which timestamp/IP columns actually exist in this schema version
        ts_col = next((c for c in _TIMESTAMP_COLUMN_CANDIDATES if c in columns), None)
        ip_col = next((c for c in _IP_COLUMN_CANDIDATES if c in columns), None)

        select_parts: List[str] = ["id"]
        if ts_col:
            select_parts.append(ts_col)
        if ip_col:
            select_parts.append(ip_col)

        query = f"SELECT {', '.join(select_parts)} FROM peers WHERE lower(hostname) = lower(?)"  # noqa: S608
        cursor = conn.execute(query, (hostname,))
        rows = cursor.fetchall()

        if not rows:
            return ResolverResult(None, "none", f"No peer matched hostname '{hostname}'")

        # Filter out rows whose stored IDs look like internal/placeholder values
        valid_rows = [r for r in rows if _is_valid_rustdesk_id(r["id"])]
        if not valid_rows:
            return ResolverResult(None, "none", f"Peers matched hostname '{hostname}' but all IDs are placeholder/invalid")

        if len(valid_rows) > 1:
            # Try IP correlation to disambiguate
            narrowed = cls._narrow_by_ip(valid_rows, local_ip=local_ip, public_ip=public_ip, ip_col=ip_col)
            if narrowed is None:
                ids = [r["id"] for r in valid_rows]
                preview = ", ".join(ids[:3]) + ("..." if len(ids) > 3 else "")
                logger.warning(
                    "[rustdesk_resolver] ambiguous: %d peers share hostname '%s' (IDs: %s)",
                    len(valid_rows), hostname, preview,
                )
                return ResolverResult(
                    None,
                    "low",
                    f"Ambiguous: {len(valid_rows)} peers share hostname '{hostname}' — IP correlation inconclusive ({preview})",
                )
            logger.info(
                "[rustdesk_resolver] IP-disambiguated: hostname='%s' → id='%s'",
                hostname, narrowed["id"],
            )
            # Still check recency for the narrowed row
            rows = [narrowed]

        row = rows[0]
        peer_id = row["id"]
        ts_value = row[ts_col] if ts_col and ts_col in row.keys() else None

        is_recent = cls._is_recent(ts_value)

        if is_recent:
            logger.info(
                "[rustdesk_resolver] high confidence match: hostname='%s' → id='%s'",
                hostname, peer_id,
            )
            return ResolverResult(peer_id, "high", "Resolved from TECHI Remote Support server")

        logger.info(
            "[rustdesk_resolver] medium confidence match: hostname='%s' → id='%s' (stale peer)",
            hostname, peer_id,
        )
        return ResolverResult(
            peer_id,
            "medium",
            f"Hostname matched stale peer ({ts_col}: {ts_value}) — not auto-updating",
        )

    @staticmethod
    def _is_recent(ts_value: Optional[object]) -> bool:
        """Return True if ts_value (seconds or ms epoch) is within the recency threshold."""
        if ts_value is None:
            return False
        try:
            ts = int(ts_value)
        except (TypeError, ValueError):
            return False
        # RustDesk may store timestamps in milliseconds (values > year 3000 in seconds)
        if ts > 32503680000:
            ts = ts // 1000
        return (int(time.time()) - ts) < _RECENT_THRESHOLD_SECONDS

    @staticmethod
    def _narrow_by_ip(rows, *, local_ip: Optional[str], public_ip: Optional[str], ip_col: Optional[str]):
        """Try to pick a single row from multiple hostname matches using IP correlation.
        Returns the single matching row, or None if still ambiguous / no IP column."""
        if not ip_col or not (local_ip or public_ip):
            return None

        candidate_ips = {ip.strip() for ip in (local_ip, public_ip) if ip and ip.strip()}
        ip_matches = [r for r in rows if r[ip_col] and r[ip_col].strip() in candidate_ips]

        if len(ip_matches) == 1:
            return ip_matches[0]
        return None
