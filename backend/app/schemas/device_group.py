from datetime import datetime
from pydantic import BaseModel


class DeviceGroupBase(BaseModel):
    name: str
    client_id: int


class DeviceGroup(DeviceGroupBase):
    id: int
    created_at: datetime

    class Config:
        orm_mode = True
