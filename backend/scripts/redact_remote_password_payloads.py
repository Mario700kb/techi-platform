"""Dry-run-first cleanup for retired plaintext Remote Support command payloads.

Run from the backend environment. The default prints row counts only. Mutation
requires both --execute and the exact confirmation phrase; never copy payloads
into tickets or logs before running this controlled cleanup.
"""

import argparse

from app.db.session import SessionLocal
from app.models.agent_command_batch import AgentCommandBatch
from app.models.remote_action import RemoteAction


CONFIRMATION = "REDACT-REMOTE-PASSWORD-PAYLOADS"


def redact(db, *, execute: bool) -> tuple[int, int]:
    actions = db.query(RemoteAction).filter(RemoteAction.action_type == "set_remote_password")
    batches = db.query(AgentCommandBatch).filter(AgentCommandBatch.command_type == "set_remote_password")
    action_count = actions.filter(RemoteAction.payload != "{}").count()
    batch_count = batches.filter(AgentCommandBatch.payload != "{}").count()
    if execute:
        actions.update({RemoteAction.payload: "{}"}, synchronize_session=False)
        batches.update({AgentCommandBatch.payload: "{}"}, synchronize_session=False)
        db.commit()
    return action_count, batch_count


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--execute", action="store_true")
    parser.add_argument("--confirm", default="")
    args = parser.parse_args()
    if args.execute and args.confirm != CONFIRMATION:
        parser.error(f"--execute requires --confirm {CONFIRMATION}")

    db = SessionLocal()
    try:
        actions, batches = redact(db, execute=args.execute)
    finally:
        db.close()
    mode = "redacted" if args.execute else "dry-run"
    print(f"{mode}: remote_actions={actions} agent_command_batches={batches}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
