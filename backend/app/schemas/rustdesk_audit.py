from typing import Any, List, Optional, Union

from pydantic import BaseModel, ConfigDict, Field

# conn_id and type land in INTEGER columns; anything outside int32 used to
# reach the database and fail there (500) instead of being refused here.
INT32_MAX = 2**31 - 1


class RustDeskConnReport(BaseModel):
    """Body RustDesk posts to /api/audit/conn (src/server/connection.rs,
    post_conn_audit): every report carries id, uuid, conn_id and session_id;
    "new" adds the caller's ip, a password accepted adds peer [id, name] and
    type, "close" nothing else."""

    model_config = ConfigDict(extra="ignore")

    id: Union[str, int]
    conn_id: int = Field(ge=0, le=INT32_MAX)
    session_id: Optional[Union[str, int]] = None
    action: Optional[str] = None
    ip: Optional[str] = None
    peer: Optional[List[Any]] = None
    type: Optional[int] = Field(default=None, ge=0, le=INT32_MAX)


class RustDeskAlarmReport(BaseModel):
    """Body RustDesk posts to /api/audit/alarm (post_alarm_audit): typ is the
    AlarmAuditType, info a JSON string with the caller's ip, id and name."""

    model_config = ConfigDict(extra="ignore")

    id: Union[str, int]
    typ: int = Field(ge=0, le=INT32_MAX)
    info: Optional[str] = Field(default=None, max_length=4096)
