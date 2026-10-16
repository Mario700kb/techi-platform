from typing import Any, List, Optional, Union

from pydantic import BaseModel, ConfigDict


class RustDeskConnReport(BaseModel):
    """Body RustDesk posts to /api/audit/conn (src/server/connection.rs,
    post_conn_audit): every report carries id, uuid, conn_id and session_id;
    "new" adds the caller's ip, a password accepted adds peer [id, name] and
    type, "close" nothing else."""

    model_config = ConfigDict(extra="ignore")

    id: Union[str, int]
    conn_id: int
    session_id: Optional[Union[str, int]] = None
    action: Optional[str] = None
    ip: Optional[str] = None
    peer: Optional[List[Any]] = None
    type: Optional[int] = None


class RustDeskAlarmReport(BaseModel):
    """Body RustDesk posts to /api/audit/alarm (post_alarm_audit): typ is the
    AlarmAuditType, info a JSON string with the caller's ip, id and name."""

    model_config = ConfigDict(extra="ignore")

    id: Union[str, int]
    typ: int
    info: Optional[str] = None
