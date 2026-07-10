"""Canonical notification event_type strings — one place so every event
source and the frontend rule builder agree on the exact spelling. Adding a
new event type is just a new constant; NotificationRule.event_type is a
free string column, so this needs no migration."""


class NotificationEvent:
    DEVICE_OFFLINE = "device_offline"
    DEVICE_ONLINE = "device_online"
    AGENT_UPDATE_FAILED = "agent_update_failed"
    AGENT_UPDATE_COMPLETED = "agent_update_completed"
    CRITICAL_ALERT = "critical_alert"
    MAINTENANCE_FINISHED = "maintenance_finished"
    REMOTE_ACTION_FAILED = "remote_action_failed"
    REMOTE_ACTION_COMPLETED = "remote_action_completed"
    ENROLLMENT_FAILED = "enrollment_failed"
    TERMINAL_SESSION_STARTED = "terminal_session_started"
    TERMINAL_SESSION_ENDED = "terminal_session_ended"


ALL_EVENT_TYPES = [
    NotificationEvent.DEVICE_OFFLINE,
    NotificationEvent.DEVICE_ONLINE,
    NotificationEvent.AGENT_UPDATE_FAILED,
    NotificationEvent.AGENT_UPDATE_COMPLETED,
    NotificationEvent.CRITICAL_ALERT,
    NotificationEvent.MAINTENANCE_FINISHED,
    NotificationEvent.REMOTE_ACTION_FAILED,
    NotificationEvent.REMOTE_ACTION_COMPLETED,
    NotificationEvent.ENROLLMENT_FAILED,
    NotificationEvent.TERMINAL_SESSION_STARTED,
    NotificationEvent.TERMINAL_SESSION_ENDED,
]
