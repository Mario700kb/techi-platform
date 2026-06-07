import logging
import logging.config
import logging.handlers
import os


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
            "uvicorn.access": {"handlers": ["console", "file"], "propagate": False, "level": log_level},
        },
    }
    logging.config.dictConfig(config)
