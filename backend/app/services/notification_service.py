"""Notification Engine (single subsystem, reused by every event source).

Two responsibilities, kept separate on purpose:
  - NotificationService.dispatch()  — called by event sources (Alert Engine,
    Remote Actions, Terminal, Enrollment, Maintenance). Resolves matching
    rules, applies severity/cooldown/rate-limit filtering, and makes ONE
    immediate send attempt per matched rule.
  - The retry/backoff sweep for anything that failed on the first attempt
    lives in app/workers/notification_worker.py — dispatch() never blocks
    an event source waiting on retries.

Gated by FEATURE_NOTIFICATIONS (checked once, at the top of dispatch) so
flag-off callers pay only the cost of one boolean check — no new behavior,
no new queries, matching every other Platform Expansion flag's contract.
"""

import json
import logging
from datetime import timedelta
from typing import Any, Dict, Optional, Tuple

from sqlalchemy.orm import Session

from app.core.time import utcnow
from app.core.vault_cipher import VaultCipherError, decrypt_secret, encrypt_secret
from app.models.notification import (
    NotificationChannel,
    NotificationDelivery,
    NotificationRule,
    SEVERITY_ORDER,
)
from app.platform_core.flags import feature_enabled
from app.repositories.notification_repository import (
    NotificationChannelRepository,
    NotificationDeliveryRepository,
    NotificationRuleRepository,
)
from app.services.notification_channels import send_via_channel

logger = logging.getLogger(__name__)

# Backoff schedule for retries (worker consumes this too). Fixed, small,
# and bounded — after the last step a delivery is marked FAILED for good.
RETRY_BACKOFF_MINUTES = [1, 5, 15, 30]
MAX_ATTEMPTS = len(RETRY_BACKOFF_MINUTES) + 1  # +1 for the immediate first attempt


def _severity_index(value: Optional[str]) -> int:
    if value is None:
        return 0
    try:
        return SEVERITY_ORDER.index(value)
    except ValueError:
        return 0


class NotificationService:
    def __init__(self, db: Session):
        self.db = db
        self.channels = NotificationChannelRepository(db)
        self.rules = NotificationRuleRepository(db)
        self.deliveries = NotificationDeliveryRepository(db)

    # ---- channel config/secret helpers -----------------------------------

    @staticmethod
    def _decode_config(channel: NotificationChannel) -> Dict[str, Any]:
        try:
            return json.loads(channel.config_json) if channel.config_json else {}
        except (TypeError, ValueError):
            return {}

    @staticmethod
    def encode_config(config: Dict[str, Any]) -> str:
        return json.dumps(config)

    def _decrypt_secret(self, channel: NotificationChannel) -> Optional[str]:
        if not channel.secret_ciphertext or not channel.secret_dek_wrapped:
            return None
        try:
            return decrypt_secret(channel.secret_ciphertext, channel.secret_dek_wrapped)
        except VaultCipherError:
            logger.exception("Failed to decrypt secret for notification channel #%d", channel.id)
            return None

    @staticmethod
    def encrypt_secret_for_storage(secret: str) -> Tuple[str, str]:
        return encrypt_secret(secret)

    # ---- filters ------------------------------------------------------

    def _cooldown_active(self, rule: NotificationRule) -> bool:
        if not rule.cooldown_seconds:
            return False
        last = self.deliveries.last_for_rule(rule.id)
        if last is None:
            return False
        return (utcnow() - last.created_at) < timedelta(seconds=rule.cooldown_seconds)

    def _rate_limited(self, rule: NotificationRule) -> bool:
        if not rule.rate_limit_per_hour:
            return False
        since = utcnow() - timedelta(hours=1)
        return self.deliveries.count_for_rule_since(rule.id, since) >= rule.rate_limit_per_hour

    # ---- send -----------------------------------------------------------

    def _attempt_send(self, channel: NotificationChannel, delivery: NotificationDelivery) -> bool:
        config = self._decode_config(channel)
        secret = self._decrypt_secret(channel)
        payload = None
        if delivery.payload_json:
            try:
                payload = json.loads(delivery.payload_json)
            except (TypeError, ValueError):
                payload = None

        delivery.attempt_count += 1
        ok, error = send_via_channel(
            channel.channel_type,
            config=config,
            secret=secret,
            title=delivery.title,
            message=delivery.message,
            event_type=delivery.event_type,
            payload=payload,
        )
        if ok:
            self.deliveries.mark_sent(delivery)
            return True

        if delivery.attempt_count >= MAX_ATTEMPTS:
            self.deliveries.mark_failed(delivery, error or "delivery failed")
        else:
            backoff_minutes = RETRY_BACKOFF_MINUTES[min(delivery.attempt_count - 1, len(RETRY_BACKOFF_MINUTES) - 1)]
            self.deliveries.mark_retry(delivery, error or "delivery failed", utcnow() + timedelta(minutes=backoff_minutes))
        return False

    def retry_delivery(self, delivery: NotificationDelivery) -> bool:
        """Used by the retry worker — same send path as the first attempt."""
        channel = self.channels.get(delivery.channel_id)
        if channel is None or not channel.enabled:
            self.deliveries.mark_failed(delivery, "channel deleted or disabled")
            return False
        return self._attempt_send(channel, delivery)

    # ---- dispatch (public entry point for every event source) -----------

    def dispatch(
        self,
        *,
        event_type: str,
        title: str,
        message: str,
        severity: Optional[str] = None,
        device_id: Optional[int] = None,
        client_id: Optional[int] = None,
        payload: Optional[Dict[str, Any]] = None,
    ) -> None:
        """Best-effort, never raises — a notification failure must never
        break the event source that triggered it (same contract as
        audit_log). Fires one immediate send attempt per matched rule;
        failures are queued for the retry worker automatically."""
        if not feature_enabled("FEATURE_NOTIFICATIONS"):
            return
        try:
            matched = self.rules.matching(event_type, client_id)
            if not matched:
                return
            for rule in matched:
                if _severity_index(severity) < _severity_index(rule.min_severity):
                    continue
                if self._cooldown_active(rule):
                    continue
                if self._rate_limited(rule):
                    continue
                channel = self.channels.get(rule.channel_id)
                if channel is None or not channel.enabled:
                    continue
                delivery = self.deliveries.create(
                    rule_id=rule.id,
                    channel_id=channel.id,
                    event_type=event_type,
                    device_id=device_id,
                    client_id=client_id,
                    title=title,
                    message=message,
                    payload_json=json.dumps(payload) if payload else None,
                )
                self._attempt_send(channel, delivery)
        except Exception:
            logger.exception("Notification dispatch failed for event_type=%s", event_type)

    def send_test(self, channel: NotificationChannel, message: Optional[str] = None) -> Tuple[bool, Optional[str]]:
        """Immediate, unretried, always recorded (status sent/failed
        directly — no retry queue for a manual test)."""
        delivery = self.deliveries.create(
            rule_id=None,
            channel_id=channel.id,
            event_type="test",
            title="TECHI test notification",
            message=message or "This is a test notification from TECHI Platform.",
            payload_json=None,
        )
        config = self._decode_config(channel)
        secret = self._decrypt_secret(channel)
        delivery.attempt_count = 1
        ok, error = send_via_channel(
            channel.channel_type,
            config=config,
            secret=secret,
            title=delivery.title,
            message=delivery.message,
            event_type="test",
            payload=None,
        )
        if ok:
            self.deliveries.mark_sent(delivery)
        else:
            self.deliveries.mark_failed(delivery, error or "test send failed")
        return ok, error
