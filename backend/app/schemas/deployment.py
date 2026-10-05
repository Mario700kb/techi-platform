from datetime import datetime
from typing import Literal, Optional

from pydantic import BaseModel

DeploymentStatus = Literal["success", "warning", "failed", "running"]


class RecentDeployment(BaseModel):
    id: str
    command_type: str
    target: str
    total: int
    completed: int
    failed: int
    timeout: int
    status: DeploymentStatus
    timestamp: datetime
    created_by_name: Optional[str] = None
