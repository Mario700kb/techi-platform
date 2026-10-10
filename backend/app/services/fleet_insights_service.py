"""Fleet trends for the dashboard: availability, alert flow, problem devices.

Availability is measured, never assumed. A device's online/offline state is
reconstructed from `device_status_history` transitions; time when its state is
genuinely unknown (before its first known state in the window) is excluded
from the denominator and reported back as coverage, so the percentage cannot
silently overstate uptime. This follows the same rule as the device report,
which refuses to print an uptime figure when the state at range start is
unknown.

Days are bucketed in DISPLAY_TIMEZONE (Europe/Tirane); storage stays UTC.
"""
from bisect import bisect_right
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from typing import Optional

from sqlalchemy import func, or_, text
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.scope import AllowedScope
from app.core.swr_cache import SWRCache, scope_cache_key
from app.core.time import _zone, utcnow
from app.models.alert import DeviceAlert
from app.models.client import Client
from app.models.device import Device, DeviceStatus
from app.models.device_status_history import DeviceStatusHistory
from app.repositories.device_repository import DeviceRepository

# Thirty-day trends move slowly and cost seconds on a large fleet: a result is
# fresh for five minutes, then served while one background thread recomputes it.
_cache: SWRCache[dict] = SWRCache("insights", ttl=300.0, max_age=6 * 3600.0)


def invalidate_insights_cache() -> None:
    _cache.clear()


def warm_insights_cache(db: Session, days: int = 30) -> None:
    """Compute the fleet-wide trends at startup so the first dashboard is instant."""
    _cache.warm(scope_cache_key(None, str(days)), db, lambda session: FleetInsightsService(session)._compute(None, days))


def _day_starts(days: int, now: datetime) -> list[datetime]:
    """UTC instants of local midnight for the last `days` days (oldest first) plus now."""
    tz = _zone(settings.DISPLAY_TIMEZONE)
    today = now.astimezone(tz).date()
    starts = []
    for offset in range(days - 1, -1, -1):
        day = today - timedelta(days=offset)
        local_midnight = datetime(day.year, day.month, day.day, tzinfo=tz)
        starts.append(local_midnight.astimezone(timezone.utc))
    return starts


def _naive_utc(value: datetime) -> datetime:
    """Storage is naive UTC; normalise aware values (SQLite tests, callers) to match."""
    return value.astimezone(timezone.utc).replace(tzinfo=None) if value.tzinfo else value


def _add_segment(start: datetime, end: datetime, is_online: bool, bounds: list[datetime],
                 online: list[float], known: list[float]) -> None:
    """Credit [start, end) to the day buckets it overlaps; bounds are sorted day edges."""
    i = max(0, bisect_right(bounds, start) - 1)
    last = len(bounds) - 1
    while i < last and bounds[i] < end:
        lo = start if start > bounds[i] else bounds[i]
        hi = end if end < bounds[i + 1] else bounds[i + 1]
        if hi > lo:
            seconds = (hi - lo).total_seconds()
            known[i] += seconds
            if is_online:
                online[i] += seconds
        i += 1


class FleetInsightsService:
    def __init__(self, db: Session):
        self.db = db

    def get_insights(self, scope: Optional[AllowedScope] = None, days: int = 30) -> dict:
        days = max(7, min(days, 60))
        return _cache.get(scope_cache_key(scope, str(days)), self.db,
                          lambda session: FleetInsightsService(session)._compute(scope, days))

    def _compute(self, scope: Optional[AllowedScope], days: int) -> dict:
        now = utcnow()
        devices = self._devices(scope)
        result = {
            "availability": self._availability(devices, days, now),
            "alerts": self._alert_trend([d.id for d in devices], 7, now),
            "problem_devices": self._problem_devices(devices, 7, now),
            "generated_at": now,
        }
        return result

    # ── inputs ────────────────────────────────────────────────────────────
    def _devices(self, scope: Optional[AllowedScope]) -> list[Device]:
        repo = DeviceRepository(self.db)
        query = self.db.query(Device)
        query = repo._apply_lifecycle_filter(query, "active")
        query = repo._apply_scope_filter(query, scope)
        return query.all()

    # ── availability ─────────────────────────────────────────────────────
    def _availability(self, devices: list[Device], days: int, now: datetime) -> dict:
        # Storage is naive UTC, so day edges are compared in that form.
        starts = _day_starts(days, now)
        bounds = [b.replace(tzinfo=None) for b in starts + [now]]
        window_start = bounds[0]
        online = [0.0] * days
        known = [0.0] * days
        ids = [d.id for d in devices]

        if ids:
            before = self._state_before(ids, window_start)
            # A large fleet writes hundreds of thousands of transitions a month.
            # On PostgreSQL the segments are cut into days inside the database,
            # so only one row per day comes back instead of every transition.
            if self.db.get_bind().dialect.name == "postgresql":
                self._availability_in_db(devices, before, bounds, online, known)
            else:
                self._availability_in_python(devices, before, bounds, online, known)

        tz = _zone(settings.DISPLAY_TIMEZONE)
        series = []
        for i, start in enumerate(starts):
            pct = round(online[i] / known[i] * 100, 2) if known[i] > 0 else None
            series.append({"date": start.astimezone(tz).date().isoformat(), "availability_pct": pct})
        total_known = sum(known)
        possible = sum((bounds[i + 1] - bounds[i]).total_seconds() for i in range(days)) * max(len(devices), 1)
        return {
            "days": days,
            "series": series,
            "overall_pct": round(sum(online) / total_known * 100, 2) if total_known > 0 else None,
            "coverage_pct": round(total_known / possible * 100, 1) if devices else None,
            "device_count": len(devices),
        }

    def _state_before(self, ids: list[int], window_start: datetime) -> dict[int, DeviceStatus]:
        """Last known status of each device before the window opened."""
        latest_before = (
            self.db.query(DeviceStatusHistory.device_id, func.max(DeviceStatusHistory.created_at).label("at"))
            .filter(DeviceStatusHistory.device_id.in_(ids),
                    DeviceStatusHistory.created_at < window_start)
            .group_by(DeviceStatusHistory.device_id)
            .subquery()
        )
        return dict(
            self.db.query(DeviceStatusHistory.device_id, DeviceStatusHistory.new_status)
            .join(latest_before, (DeviceStatusHistory.device_id == latest_before.c.device_id)
                  & (DeviceStatusHistory.created_at == latest_before.c.at))
            .all()
        )

    @staticmethod
    def _starting_point(device: Device, before: dict[int, DeviceStatus], window_start: datetime,
                        first: Optional[tuple[datetime, DeviceStatus, Optional[DeviceStatus]]]
                        ) -> tuple[datetime, DeviceStatus, bool]:
        """Where measurement of a device begins, its state there, and whether the
        first in-window transition is consumed as that starting point."""
        registered = _naive_utc(device.registered_at) if device.registered_at else window_start
        if device.id in before:
            return window_start, before[device.id], False
        if first is not None and first[2] is not None:
            return max(window_start, registered), first[2], False
        if first is None and registered <= window_start:
            # Never changed since before the window: the current status held throughout.
            return window_start, device.status, False
        if first is not None:
            return first[0], first[1], True
        return max(window_start, registered), device.status, False

    def _availability_in_python(self, devices: list[Device], before: dict[int, DeviceStatus],
                                bounds: list[datetime], online: list[float], known: list[float]) -> None:
        window_start, end = bounds[0], bounds[-1]
        transitions: dict[int, list[tuple[datetime, DeviceStatus, Optional[DeviceStatus]]]] = defaultdict(list)
        rows = (
            self.db.query(DeviceStatusHistory.device_id, DeviceStatusHistory.created_at,
                          DeviceStatusHistory.new_status, DeviceStatusHistory.previous_status)
            .filter(DeviceStatusHistory.device_id.in_([d.id for d in devices]),
                    DeviceStatusHistory.created_at >= window_start,
                    DeviceStatusHistory.created_at <= end)
            .order_by(DeviceStatusHistory.device_id, DeviceStatusHistory.created_at)
            .all()
        )
        for device_id, created_at, new_status, previous_status in rows:
            transitions[device_id].append((_naive_utc(created_at), new_status, previous_status))

        for device in devices:
            events = transitions.get(device.id, [])
            cursor, state, consumed = self._starting_point(device, before, window_start, events[0] if events else None)
            for at, new_status, _previous in events[1:] if consumed else events:
                if at > cursor:
                    _add_segment(cursor, at, state == DeviceStatus.ONLINE, bounds, online, known)
                    cursor = at
                state = new_status
            if end > cursor:
                _add_segment(cursor, end, state == DeviceStatus.ONLINE, bounds, online, known)

    def _availability_in_db(self, devices: list[Device], before: dict[int, DeviceStatus],
                            bounds: list[datetime], online: list[float], known: list[float]) -> None:
        window_start, end = bounds[0], bounds[-1]
        ids = [d.id for d in devices]
        first = {
            device_id: (_naive_utc(at), new_status, previous_status)
            for device_id, at, new_status, previous_status in (
                self.db.query(DeviceStatusHistory.device_id, DeviceStatusHistory.created_at,
                              DeviceStatusHistory.new_status, DeviceStatusHistory.previous_status)
                .filter(DeviceStatusHistory.device_id.in_(ids),
                        DeviceStatusHistory.created_at >= window_start,
                        DeviceStatusHistory.created_at <= end)
                .order_by(DeviceStatusHistory.device_id, DeviceStatusHistory.created_at)
                .distinct(DeviceStatusHistory.device_id)
                .all()
            )
        }

        # The stretch before a device's first in-window transition is decided
        # here; every transition then holds until the next one (or now), and the
        # database credits each of those segments to the days it overlaps,
        # never earlier than the device's starting point.
        cursors = []
        for device in devices:
            event = first.get(device.id)
            cursor, state, _consumed = self._starting_point(device, before, window_start, event)
            until = event[0] if event is not None else end
            if until > cursor:
                _add_segment(cursor, until, state == DeviceStatus.ONLINE, bounds, online, known)
            cursors.append(cursor)

        rows = self.db.execute(
            text("""
                WITH ev AS (
                    SELECT device_id, created_at AS s, new_status::text AS status,
                           LEAD(created_at, 1, CAST(:end AS timestamp))
                               OVER (PARTITION BY device_id ORDER BY created_at) AS e
                    FROM device_status_history
                    WHERE device_id = ANY(CAST(:ids AS integer[]))
                      AND created_at >= :window_start AND created_at <= :end
                ),
                seg AS (
                    SELECT GREATEST(ev.s, c.at) AS s, ev.e, ev.status
                    FROM ev
                    JOIN unnest(CAST(:ids AS integer[]), CAST(:cursors AS timestamp[])) AS c(device_id, at)
                      ON c.device_id = ev.device_id
                    WHERE ev.e > GREATEST(ev.s, c.at)
                ),
                parts AS (
                    SELECT g.i, seg.status,
                           EXTRACT(EPOCH FROM LEAST(seg.e, b.edges[g.i + 1]) - GREATEST(seg.s, b.edges[g.i])) AS secs
                    FROM seg
                    CROSS JOIN (SELECT CAST(:bounds AS timestamp[]) AS edges) AS b
                    CROSS JOIN LATERAL generate_series(width_bucket(seg.s, b.edges), width_bucket(seg.e, b.edges)) AS g(i)
                    WHERE g.i BETWEEN 1 AND :days
                )
                SELECT i, SUM(secs) AS known, COALESCE(SUM(secs) FILTER (WHERE status = :online), 0) AS online
                FROM parts WHERE secs > 0 GROUP BY i
            """),
            {"ids": ids, "cursors": cursors, "bounds": bounds, "window_start": window_start, "end": end,
             "days": len(bounds) - 1, "online": DeviceStatus.ONLINE.name},
        ).all()
        for i, known_secs, online_secs in rows:
            known[i - 1] += float(known_secs)
            online[i - 1] += float(online_secs)

    # ── alerts ───────────────────────────────────────────────────────────
    def _alert_trend(self, ids: list[int], days: int, now: datetime) -> dict:
        starts = _day_starts(days, now)
        window_start = starts[0].replace(tzinfo=None)
        tz = _zone(settings.DISPLAY_TIMEZONE)
        labels = [s.astimezone(tz).date().isoformat() for s in starts]
        opened = dict.fromkeys(labels, 0)
        resolved = dict.fromkeys(labels, 0)
        resolve_hours: list[float] = []
        open_now = 0
        if ids:
            rows = (
                self.db.query(DeviceAlert.created_at, DeviceAlert.resolved_at, DeviceAlert.state)
                .filter(DeviceAlert.device_id.in_(ids),
                        or_(DeviceAlert.created_at >= window_start, DeviceAlert.resolved_at >= window_start,
                            DeviceAlert.state == "open"))
                .all()
            )
            edges = [s.replace(tzinfo=None) for s in starts]
            for created_at, resolved_at, state in rows:
                created = _naive_utc(created_at)
                day = bisect_right(edges, created) - 1
                if day >= 0:
                    opened[labels[day]] += 1
                if resolved_at is not None:
                    done = _naive_utc(resolved_at)
                    day = bisect_right(edges, done) - 1
                    if day >= 0:
                        resolved[labels[day]] += 1
                        resolve_hours.append((done - created).total_seconds() / 3600)
                if getattr(state, "value", state) == "open":
                    open_now += 1
        return {
            "days": days,
            "series": [{"date": d, "opened": opened[d], "resolved": resolved[d]} for d in labels],
            "opened_total": sum(opened.values()),
            "resolved_total": sum(resolved.values()),
            "open_now": open_now,
            "mean_time_to_resolve_hours": round(sum(resolve_hours) / len(resolve_hours), 1) if resolve_hours else None,
        }

    # ── problem devices ──────────────────────────────────────────────────
    def _problem_devices(self, devices: list[Device], days: int, now: datetime, limit: int = 5) -> list[dict]:
        if not devices:
            return []
        ids = [d.id for d in devices]
        window_start = (now - timedelta(days=days)).replace(tzinfo=None)
        offline_events = dict(
            self.db.query(DeviceStatusHistory.device_id, func.count(DeviceStatusHistory.id))
            .filter(DeviceStatusHistory.device_id.in_(ids), DeviceStatusHistory.created_at >= window_start,
                    DeviceStatusHistory.new_status == DeviceStatus.OFFLINE)
            .group_by(DeviceStatusHistory.device_id)
            .all()
        )
        alert_counts = dict(
            self.db.query(DeviceAlert.device_id, func.count(DeviceAlert.id))
            .filter(DeviceAlert.device_id.in_(ids), DeviceAlert.created_at >= window_start)
            .group_by(DeviceAlert.device_id)
            .all()
        )
        scored = [
            (offline_events.get(d.id, 0) + alert_counts.get(d.id, 0), d)
            for d in devices
            if offline_events.get(d.id, 0) or alert_counts.get(d.id, 0)
        ]
        scored.sort(key=lambda pair: (-pair[0], (pair[1].hostname or "").lower()))
        top = scored[:limit]
        client_names = dict(
            self.db.query(Client.id, Client.name).filter(Client.id.in_({d.client_id for _, d in top if d.client_id})).all()
        ) if top else {}
        return [
            {
                "device_id": d.id,
                "name": d.display_name or d.hostname or f"Device #{d.id}",
                "client_name": client_names.get(d.client_id),
                "offline_events": offline_events.get(d.id, 0),
                "alerts": alert_counts.get(d.id, 0),
                "freshness_state": d.freshness_state,
            }
            for _, d in top
        ]
