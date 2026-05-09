from datetime import datetime
from typing import Literal

from pydantic import BaseModel


class RecentDeployment(BaseModel):
    id: int
    title: str
    environment: str
    status: Literal["success", "warning", "failed"]
    timestamp: datetime
