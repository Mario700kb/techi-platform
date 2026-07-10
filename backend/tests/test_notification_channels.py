"""Notification Engine — channel senders (Email/SMTP, Webhook).

smtplib and httpx are mocked so these run offline; the point is verifying
message construction and error surfacing, not real network I/O.
"""

from unittest.mock import MagicMock, patch

import httpx

from app.services.notification_channels import CHANNEL_SENDERS, EmailSender, WebhookSender, send_via_channel


def test_email_missing_fields_fails_without_sending():
    sender = EmailSender()
    ok, error = sender.send(
        config={}, secret=None, title="t", message="m", event_type="device_offline", payload=None,
    )
    assert ok is False
    assert "smtp_host" in error


def test_email_sends_via_smtp(monkeypatch):
    sent = {}

    class _FakeSMTP:
        def __init__(self, host, port, timeout):
            sent["host"] = host
            sent["port"] = port

        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

        def starttls(self):
            sent["tls"] = True

        def login(self, username, password):
            sent["login"] = (username, password)

        def sendmail(self, from_addr, to_addrs, message):
            sent["from"] = from_addr
            sent["to"] = to_addrs
            sent["message"] = message

    with patch("smtplib.SMTP", _FakeSMTP):
        sender = EmailSender()
        ok, error = sender.send(
            config={
                "smtp_host": "smtp.example.com",
                "smtp_port": 587,
                "use_tls": True,
                "username": "alerts@example.com",
                "from_address": "alerts@example.com",
                "to_addresses": ["ops@example.com"],
            },
            secret="hunter2",
            title="Device offline",
            message="host-1 went offline",
            event_type="device_offline",
            payload=None,
        )
    assert ok is True
    assert error is None
    assert sent["host"] == "smtp.example.com"
    assert sent["tls"] is True
    assert sent["login"] == ("alerts@example.com", "hunter2")
    assert sent["to"] == ["ops@example.com"]
    assert "Device offline" in sent["message"]


def test_email_smtp_failure_returns_error():
    import smtplib

    class _FailingSMTP:
        def __init__(self, *a, **kw):
            raise smtplib.SMTPConnectError(421, "cannot connect")

    with patch("smtplib.SMTP", _FailingSMTP):
        sender = EmailSender()
        ok, error = sender.send(
            config={
                "smtp_host": "smtp.example.com", "from_address": "a@b.com", "to_addresses": ["c@d.com"],
            },
            secret=None, title="t", message="m", event_type="device_offline", payload=None,
        )
    assert ok is False
    assert error


def test_webhook_missing_url_fails():
    sender = WebhookSender()
    ok, error = sender.send(config={}, secret=None, title="t", message="m", event_type="device_offline", payload=None)
    assert ok is False
    assert "url" in error


def test_webhook_posts_json_with_secret_header(monkeypatch):
    captured = {}

    def _fake_post(url, json, headers, timeout):
        captured["url"] = url
        captured["json"] = json
        captured["headers"] = headers
        response = MagicMock()
        response.status_code = 200
        return response

    monkeypatch.setattr(httpx, "post", _fake_post)
    sender = WebhookSender()
    ok, error = sender.send(
        config={"url": "https://hooks.example.com/techi", "headers": {"X-Custom": "1"}},
        secret="shared-secret",
        title="Device offline",
        message="host-1 went offline",
        event_type="device_offline",
        payload={"device_id": 1},
    )
    assert ok is True
    assert error is None
    assert captured["url"] == "https://hooks.example.com/techi"
    assert captured["headers"]["X-Custom"] == "1"
    assert captured["headers"]["X-TECHI-Signature"] == "shared-secret"
    assert captured["json"]["event_type"] == "device_offline"
    assert captured["json"]["payload"] == {"device_id": 1}


def test_webhook_non_2xx_status_is_failure(monkeypatch):
    def _fake_post(url, json, headers, timeout):
        response = MagicMock()
        response.status_code = 500
        response.text = "internal error"
        return response

    monkeypatch.setattr(httpx, "post", _fake_post)
    sender = WebhookSender()
    ok, error = sender.send(
        config={"url": "https://hooks.example.com/techi"},
        secret=None, title="t", message="m", event_type="device_offline", payload=None,
    )
    assert ok is False
    assert "500" in error


def test_webhook_network_error_is_failure(monkeypatch):
    def _fake_post(url, json, headers, timeout):
        raise httpx.ConnectError("connection refused")

    monkeypatch.setattr(httpx, "post", _fake_post)
    sender = WebhookSender()
    ok, error = sender.send(
        config={"url": "https://hooks.example.com/techi"},
        secret=None, title="t", message="m", event_type="device_offline", payload=None,
    )
    assert ok is False
    assert error


def test_send_via_channel_dispatches_to_registered_sender(monkeypatch):
    monkeypatch.setattr(WebhookSender, "send", lambda self, **kwargs: (True, None))
    ok, error = send_via_channel(
        "webhook", config={"url": "https://x"}, secret=None, title="t", message="m", event_type="e",
    )
    assert ok is True


def test_send_via_channel_unknown_type_fails():
    ok, error = send_via_channel("slack", config={}, secret=None, title="t", message="m", event_type="e")
    assert ok is False
    assert "unknown channel type" in error


def test_channel_registry_has_email_and_webhook():
    assert set(CHANNEL_SENDERS.keys()) == {"email", "webhook"}
