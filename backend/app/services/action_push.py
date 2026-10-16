"""Deliver a just-queued action over the agent command channel.

Used for actions an operator queues for one device: the agent runs them within
a second or two instead of at its next heartbeat. Bulk commands deliberately do
not use it — the heartbeat spreads a fleet-wide self_update over five minutes,
where an instant push would start every download at once.
"""
import asyncio
import logging

logger = logging.getLogger(__name__)


# Long enough for a healthy loop to accept a frame, short enough that a wedged
# one cannot stall the operator's request behind it.
_PUSH_TIMEOUT_SECONDS = 5.0


def push_action_if_connected(device_id: int, action, action_svc) -> bool:
    """Deliver a queued action over the agent command channel, if one is open.

    Best-effort by design. Any failure — no channel, a dead socket, an event
    loop that will not schedule — leaves the action queued for the heartbeat
    path, which is exactly the pre-2026-08-04 behaviour. Opening a terminal
    must never fail because the accelerator did. The same holds for every
    single-device action an operator queues (actions, Remote Support).

    Two ordering rules make that promise true, both learned the hard way on
    2026-08-05 when this function marked actions SENT that it then failed to
    push, leaving them deliverable by nobody (the heartbeat path collects only
    QUEUED work) and every retry blocked by the duplicate-action guard:

    1. The frame goes on the wire *before* the action is marked SENT.
    2. This endpoint is sync, so it runs in a worker thread with no running
       loop. The push is scheduled onto the main loop captured at startup;
       `asyncio.get_running_loop()` here raises RuntimeError, always.
    """
    from app.websocket.agent_channel import agent_command_channel, get_main_loop

    if not agent_command_channel.is_connected(device_id):
        return False

    loop = get_main_loop()
    if loop is None:
        logger.warning("command channel: no main event loop captured; heartbeat will deliver for device %s", device_id)
        return False

    try:
        # Build without mutating: if the push fails, the action must still look
        # untouched so the heartbeat path picks it up normally.
        delivery = action_svc.build_delivery(action)
        payload = {"type": "action", "action": delivery.model_dump()}
        future = asyncio.run_coroutine_threadsafe(
            agent_command_channel.push(device_id, payload), loop
        )
        # Bounded: a wedged loop must not hold the operator's HTTP request open.
        pushed = future.result(timeout=_PUSH_TIMEOUT_SECONDS)
    except Exception:
        logger.exception("command channel: push failed for device %s; heartbeat will deliver", device_id)
        return False

    if not pushed:
        # push() reports False for an unconnected or dead socket. Leave the
        # action QUEUED so the heartbeat delivers it.
        return False

    action_svc.mark_delivered(action)
    return True
