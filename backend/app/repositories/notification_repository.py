from typing import List, Optional

from sqlalchemy import and_, or_
from sqlalchemy.orm import Session

from app.core.time import utcnow
from app.models.notification import (
    NotificationChannel,
    NotificationDelivery,
    NotificationDeliveryStatus,
    NotificationRule,
    NotificationScopeType,
)


class NotificationChannelRepository:
    def __init__(self, db: Session):
        self.db = db

    def list(self) -> List[NotificationChannel]:
        return self.db.query(NotificationChannel).order_by(NotificationChannel.name).all()

    def get(self, channel_id: int) -> Optional[NotificationChannel]:
        return self.db.query(NotificationChannel).filter(NotificationChannel.id == channel_id).first()

    def create(self, **kwargs) -> NotificationChannel:
        channel = NotificationChannel(**kwargs)
        self.db.add(channel)
        self.db.commit()
        self.db.refresh(channel)
        return channel

    def update(self, channel: NotificationChannel, **kwargs) -> NotificationChannel:
        for key, value in kwargs.items():
            setattr(channel, key, value)
        channel.updated_at = utcnow()
        self.db.commit()
        self.db.refresh(channel)
        return channel

    def delete(self, channel: NotificationChannel) -> None:
        self.db.delete(channel)
        self.db.commit()


class NotificationRuleRepository:
    def __init__(self, db: Session):
        self.db = db

    def list(self) -> List[NotificationRule]:
        return self.db.query(NotificationRule).order_by(NotificationRule.event_type).all()

    def get(self, rule_id: int) -> Optional[NotificationRule]:
        return self.db.query(NotificationRule).filter(NotificationRule.id == rule_id).first()

    def matching(self, event_type: str, client_id: Optional[int]) -> List[NotificationRule]:
        """Rules for this event_type that are enabled and in scope: global
        rules always match; client-scoped rules match only when client_id
        equals the event's client_id."""
        query = self.db.query(NotificationRule).filter(
            NotificationRule.event_type == event_type,
            NotificationRule.enabled.is_(True),
        )
        if client_id is None:
            query = query.filter(NotificationRule.scope_type == NotificationScopeType.GLOBAL.value)
        else:
            query = query.filter(
                or_(
                    NotificationRule.scope_type == NotificationScopeType.GLOBAL.value,
                    and_(
                        NotificationRule.scope_type == NotificationScopeType.CLIENT.value,
                        NotificationRule.client_id == client_id,
                    ),
                )
            )
        return query.all()

    def create(self, **kwargs) -> NotificationRule:
        rule = NotificationRule(**kwargs)
        self.db.add(rule)
        self.db.commit()
        self.db.refresh(rule)
        return rule

    def update(self, rule: NotificationRule, **kwargs) -> NotificationRule:
        for key, value in kwargs.items():
            setattr(rule, key, value)
        rule.updated_at = utcnow()
        self.db.commit()
        self.db.refresh(rule)
        return rule

    def delete(self, rule: NotificationRule) -> None:
        self.db.delete(rule)
        self.db.commit()


class NotificationDeliveryRepository:
    def __init__(self, db: Session):
        self.db = db

    def create(self, **kwargs) -> NotificationDelivery:
        delivery = NotificationDelivery(**kwargs)
        self.db.add(delivery)
        self.db.commit()
        self.db.refresh(delivery)
        return delivery

    def get(self, delivery_id: int) -> Optional[NotificationDelivery]:
        return self.db.query(NotificationDelivery).filter(NotificationDelivery.id == delivery_id).first()

    def mark_sent(self, delivery: NotificationDelivery) -> NotificationDelivery:
        delivery.status = NotificationDeliveryStatus.SENT.value
        delivery.sent_at = utcnow()
        delivery.next_retry_at = None
        self.db.commit()
        self.db.refresh(delivery)
        return delivery

    def mark_retry(self, delivery: NotificationDelivery, error: str, next_retry_at) -> NotificationDelivery:
        delivery.status = NotificationDeliveryStatus.RETRYING.value
        delivery.last_error = error[:1024]
        delivery.next_retry_at = next_retry_at
        self.db.commit()
        self.db.refresh(delivery)
        return delivery

    def mark_failed(self, delivery: NotificationDelivery, error: str) -> NotificationDelivery:
        delivery.status = NotificationDeliveryStatus.FAILED.value
        delivery.last_error = error[:1024]
        delivery.next_retry_at = None
        self.db.commit()
        self.db.refresh(delivery)
        return delivery

    def last_for_rule(self, rule_id: int) -> Optional[NotificationDelivery]:
        return (
            self.db.query(NotificationDelivery)
            .filter(NotificationDelivery.rule_id == rule_id)
            .order_by(NotificationDelivery.created_at.desc())
            .first()
        )

    def count_for_rule_since(self, rule_id: int, since) -> int:
        return (
            self.db.query(NotificationDelivery)
            .filter(NotificationDelivery.rule_id == rule_id, NotificationDelivery.created_at >= since)
            .count()
        )

    def due_for_retry(self, limit: int = 50) -> List[NotificationDelivery]:
        now = utcnow()
        return (
            self.db.query(NotificationDelivery)
            .filter(
                NotificationDelivery.status == NotificationDeliveryStatus.RETRYING.value,
                NotificationDelivery.next_retry_at <= now,
            )
            .order_by(NotificationDelivery.next_retry_at.asc())
            .limit(limit)
            .all()
        )

    def list_history(
        self,
        *,
        channel_id: Optional[int] = None,
        event_type: Optional[str] = None,
        status: Optional[str] = None,
        limit: int = 50,
        offset: int = 0,
    ):
        query = self.db.query(NotificationDelivery)
        if channel_id is not None:
            query = query.filter(NotificationDelivery.channel_id == channel_id)
        if event_type is not None:
            query = query.filter(NotificationDelivery.event_type == event_type)
        if status is not None:
            query = query.filter(NotificationDelivery.status == status)
        total = query.count()
        items = query.order_by(NotificationDelivery.created_at.desc()).offset(offset).limit(limit).all()
        return items, total
