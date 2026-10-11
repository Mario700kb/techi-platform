"""Credentials that travel in URLs never reach the logs.

uvicorn logged the dashboard WebSocket URL with the operator's session JWT
(`/ws/devices?...&token=<jwt>`) on every connection, and the install and
bootstrap endpoints' enrollment tokens with every request, to the console and
the rotating log file alike.
"""
import io
import logging

import pytest

from app.core.logging_config import _RedactSecrets

JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIyIn0.c2lnbmF0dXJl"


@pytest.fixture()
def captured():
    stream = io.StringIO()
    handler = logging.StreamHandler(stream)
    handler.setFormatter(logging.Formatter("%(message)s"))
    handler.addFilter(_RedactSecrets())
    logger = logging.getLogger("test.redaction")
    logger.handlers = [handler]
    logger.propagate = False
    logger.setLevel(logging.INFO)
    yield logger, stream
    logger.handlers = []


def test_websocket_session_token_is_masked(captured):
    logger, stream = captured
    # uvicorn.error's websocket accept line, formatted from args.
    logger.info('%s - "WebSocket %s" [accepted]', "('172.18.0.1', 53490)", f"/ws/devices?tenant_id=default&token={JWT}")

    line = stream.getvalue()
    assert JWT not in line
    assert "/ws/devices?tenant_id=default&token=[redacted]" in line


def test_access_log_enrollment_token_is_masked_and_the_rest_kept(captured):
    logger, stream = captured
    # uvicorn.access passes (client, method, path, http version, status).
    logger.info('%s - "%s %s HTTP/%s" %d', "10.0.0.5:4410", "GET", "/api/v1/install/mikrotik?token=enr_SECRET123&arch=arm64", "1.1", 200)

    line = stream.getvalue()
    assert "enr_SECRET123" not in line
    assert "/api/v1/install/mikrotik?token=[redacted]&arch=arm64" in line
    assert line.rstrip().endswith("200")


@pytest.mark.parametrize("param", ["token", "access_token", "ticket", "TOKEN"])
def test_every_secret_parameter_is_masked(captured, param):
    logger, stream = captured
    logger.info("GET /x?a=1&%s=s3cr3t-value&b=2", param)

    assert "s3cr3t-value" not in stream.getvalue()


def test_lines_without_secrets_are_untouched(captured):
    logger, stream = captured
    logger.info("GET /api/v1/devices/?quick_filter=critical&tokens_page=2 %s", "ok")

    assert stream.getvalue().strip() == "GET /api/v1/devices/?quick_filter=critical&tokens_page=2 ok"
