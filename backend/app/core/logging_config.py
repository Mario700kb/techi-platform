import logging
import logging.config
import logging.handlers
import os


class _DropNoisyAccessLogs(logging.Filter):
    """
    Drop uvicorn access lines for high-frequency machine endpoints (agent
    heartbeats every 60-300 s per device, container healthchecks every 15 s).
    Errors on these endpoints still surface via application logs.
    """

    _NOISY_FRAGMENTS = (
        "/api/v1/agent/heartbeat",
        "/health",
    )

    def filter(self, record: logging.LogRecord) -> bool:
        message = record.getMessage()
        return not any(fragment in message for fragment in self._NOISY_FRAGMENTS)


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
        },
        "handlers": {
            "console": {
                "class": "logging.StreamHandler",
                "stream": "ext://sys.stdout",
                "formatter": "default",
            },
            "file": {
                "class": "logging.handlers.RotatingFileHandler",
                "filename": os.path.join(log_dir, "techi.log"),
                "maxBytes": 10 * 1024 * 1024,  # 10 MB per file
                "backupCount": 5,
                "formatter": "default",
                "encoding": "utf-8",
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
