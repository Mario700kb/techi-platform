import logging
import logging.config
import logging.handlers
import os
import re
import threading
import time


class _RedactSecrets(logging.Filter):
    """
    Mask credentials that travel in URLs before any line reaches a log.

    The dashboard WebSocket carries the operator's session JWT as `?token=`,
    and the install/bootstrap endpoints carry enrollment tokens the same way;
    uvicorn logs the full URL on every connection and request, so the logs
    held replayable sessions and usable enrollment tokens. Attached to the
    handlers, not to one logger, so it covers every logger that writes.
    """

    _SECRET_QUERY = re.compile(r"([?&](?:token|access_token|ticket|auth)=)[^&\s\"']+", re.IGNORECASE)

    def filter(self, record: logging.LogRecord) -> bool:
        try:
            message = record.getMessage()
        except Exception:  # pragma: no cover - a malformed record is not ours to fix
            return True
        redacted = self._SECRET_QUERY.sub(r"\1[redacted]", message)
        if redacted != message:
            record.msg = redacted
            record.args = None
        return True


class _DropNoisyAccessLogs(logging.Filter):
    """
    Drop uvicorn access lines for high-frequency machine endpoints (agent
    heartbeats every 60-300 s per device, container healthchecks every 15 s).
    Errors on these endpoints still surface via application logs.

    Dropped lines are counted and summarised once per SUMMARY_INTERVAL_SECONDS
    on the `techi.access_summary` logger. Silence is not the same as absence:
    during the 2026-08-03 incident this filter made the agent heartbeat traffic
    completely invisible, and a first reading of the logs concluded there was
    none at all. One aggregate line per minute keeps the volume negligible
    while leaving the rate observable.
    """

    _NOISY_FRAGMENTS = (
        "/api/v1/agent/heartbeat",
        "/health",
    )

    SUMMARY_INTERVAL_SECONDS = 60.0

    def __init__(self, name: str = "") -> None:
        super().__init__(name)
        self._lock = threading.Lock()
        self._counts: dict = {}
        self._window_started = time.monotonic()
        # Deliberately not a child of the filtered logger: emitting through
        # `uvicorn.access` would re-enter this filter.
        self._summary_log = logging.getLogger("techi.access_summary")

    def filter(self, record: logging.LogRecord) -> bool:
        message = record.getMessage()
        matched = next((f for f in self._NOISY_FRAGMENTS if f in message), None)
        if matched is None:
            return True
        self._record_drop(matched)
        return False

    def _record_drop(self, fragment: str) -> None:
        due = False
        snapshot = None
        elapsed = 0.0
        with self._lock:
            self._counts[fragment] = self._counts.get(fragment, 0) + 1
            elapsed = time.monotonic() - self._window_started
            if elapsed >= self.SUMMARY_INTERVAL_SECONDS:
                snapshot = self._counts
                self._counts = {}
                self._window_started = time.monotonic()
                due = True
        if not due or not snapshot:
            return
        parts = ", ".join(
            f"{fragment} x{count} ({count / elapsed:.2f}/s)"
            for fragment, count in sorted(snapshot.items())
        )
        # Never let observability break a request path.
        try:
            self._summary_log.info("suppressed access logs in %.0fs: %s", elapsed, parts)
        except Exception:  # pragma: no cover - defensive
            pass


def configure_logging() -> None:
    log_dir = os.getenv("LOG_DIR", "/app/logs")
    log_level = os.getenv("LOG_LEVEL", "INFO").upper()

    os.makedirs(log_dir, exist_ok=True)

    config: dict = {
        "version": 1,
        "disable_existing_loggers": False,
        "formatters": {
            "default": {
                "format": "%(asctime)s %(levelname)s %(name)s %(message)s",
                "datefmt": "%Y-%m-%dT%H:%M:%S",
            },
        },
        "filters": {
            "drop_noisy_access": {
                "()": _DropNoisyAccessLogs,
            },
            "redact_secrets": {
                "()": _RedactSecrets,
            },
        },
        "handlers": {
            "console": {
                "class": "logging.StreamHandler",
                "stream": "ext://sys.stdout",
                "formatter": "default",
                "filters": ["redact_secrets"],
            },
            "file": {
                "class": "logging.handlers.RotatingFileHandler",
                "filename": os.path.join(log_dir, "techi.log"),
                "maxBytes": 10 * 1024 * 1024,  # 10 MB per file
                "backupCount": 5,
                "formatter": "default",
                "encoding": "utf-8",
                "filters": ["redact_secrets"],
            },
        },
        "root": {
            "level": log_level,
            "handlers": ["console", "file"],
        },
        "loggers": {
            "uvicorn": {"handlers": ["console", "file"], "propagate": False, "level": log_level},
            "uvicorn.error": {"handlers": ["console", "file"], "propagate": False, "level": log_level},
            "uvicorn.access": {
                "handlers": ["console", "file"],
                "propagate": False,
                "level": log_level,
                "filters": ["drop_noisy_access"],
            },
        },
    }
    logging.config.dictConfig(config)
