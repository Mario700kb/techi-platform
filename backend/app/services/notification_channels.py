"""Pluggable notification channel senders.

Each channel type is one small class implementing `send()`. Adding a future
channel (Slack, Microsoft Teams, Telegram, Discord, PagerDuty) means writing
one new sender class and adding it to `CHANNEL_SENDERS` — nothing in
`NotificationService.dispatch()` or the delivery/retry worker changes.
"""

import logging
import smtplib
import socket
from abc import ABC, abstractmethod
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from typing import Any, Dict, Optional, Tuple

import httpx

logger = logging.getLogger(__name__)

SEND_TIMEOUT_SECONDS = 10


class NotificationSender(ABC):
    """`config` is the channel's non-secret JSON config; `secret` is the
    decrypted secret (SMTP password / webhook shared secret), or None."""

    @abstractmethod
    def send(
        self,
        *,
        config: Dict[str, Any],
        secret: Optional[str],
        title: str,
        message: str,
        event_type: str,
        payload: Optional[Dict[str, Any]],
    ) -> Tuple[bool, Optional[str]]:
        """Returns (success, error_message)."""
        raise NotImplementedError


def _plain_text_body(title: str, message: str, event_type: str) -> str:
    return f"{title}\n\n{message}\n\n--\nEvent: {event_type}\nSent by TECHI Platform"


def _html_body(title: str, message: str, event_type: str) -> str:
    safe_title = (title or "").replace("<", "&lt;")
    safe_message = (message or "").replace("<", "&lt;").replace("\n", "<br>")
    return (
        f'<div style="font-family:sans-serif;max-width:560px">'
        f"<h2 style=\"margin:0 0 12px\">{safe_title}</h2>"
        f'<p style="white-space:pre-wrap">{safe_message}</p>'
        f'<hr style="border:none;border-top:1px solid #ddd;margin:16px 0">'
        f'<p style="color:#888;font-size:12px">Event: {event_type} &middot; Sent by TECHI Platform</p>'
        f"</div>"
    )


class EmailSender(NotificationSender):
    """SMTP with optional STARTTLS + auth. `config` shape:
    {smtp_host, smtp_port, use_tls, username, from_address, to_addresses:[..]}.
    `secret` is the SMTP password (may be None for an unauthenticated relay)."""

    def send(self, *, config, secret, title, message, event_type, payload):
        host = config.get("smtp_host")
        port = int(config.get("smtp_port") or 587)
        use_tls = bool(config.get("use_tls", True))
        username = config.get("username")
        from_address = config.get("from_address") or username
        to_addresses = config.get("to_addresses") or []

        if not host or not from_address or not to_addresses:
            return False, "email channel is missing smtp_host, from_address, or to_addresses"

        mime = MIMEMultipart("alternative")
        mime["Subject"] = title
        mime["From"] = from_address
        mime["To"] = ", ".join(to_addresses)
        mime.attach(MIMEText(_plain_text_body(title, message, event_type), "plain"))
        mime.attach(MIMEText(_html_body(title, message, event_type), "html"))

        try:
            with smtplib.SMTP(host, port, timeout=SEND_TIMEOUT_SECONDS) as smtp:
                if use_tls:
                    smtp.starttls()
                if username and secret:
                    smtp.login(username, secret)
                smtp.sendmail(from_address, to_addresses, mime.as_string())
            return True, None
        except (smtplib.SMTPException, socket.error, OSError) as exc:
            logger.warning("notification email send failed: %s", exc)
            return False, str(exc)


class WebhookSender(NotificationSender):
    """POST JSON with configurable headers. `config` shape: {url, headers:{..}}.
    `secret`, if set, is sent as the `X-TECHI-Signature` header (shared-secret
    scheme — the receiving endpoint compares it verbatim)."""

    def send(self, *, config, secret, title, message, event_type, payload):
        url = config.get("url")
        if not url:
            return False, "webhook channel is missing url"

        headers = dict(config.get("headers") or {})
        headers.setdefault("Content-Type", "application/json")
        if secret:
            headers["X-TECHI-Signature"] = secret

        body = {
            "event_type": event_type,
            "title": title,
            "message": message,
            "payload": payload or {},
        }
        try:
            response = httpx.post(url, json=body, headers=headers, timeout=SEND_TIMEOUT_SECONDS)
            if response.status_code >= 400:
                return False, f"webhook returned HTTP {response.status_code}: {response.text[:300]}"
            return True, None
        except httpx.HTTPError as exc:
            logger.warning("notification webhook send failed: %s", exc)
            return False, str(exc)


CHANNEL_SENDERS: Dict[str, NotificationSender] = {
    "email": EmailSender(),
    "webhook": WebhookSender(),
}


def send_via_channel(
    channel_type: str,
    *,
    config: Dict[str, Any],
    secret: Optional[str],
    title: str,
    message: str,
    event_type: str,
    payload: Optional[Dict[str, Any]] = None,
) -> Tuple[bool, Optional[str]]:
    sender = CHANNEL_SENDERS.get(channel_type)
    if sender is None:
        return False, f"unknown channel type: {channel_type}"
    return sender.send(
        config=config, secret=secret, title=title, message=message, event_type=event_type, payload=payload
    )
