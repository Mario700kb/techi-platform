from pydantic import BaseModel


class HealthResponse(BaseModel):
    status: str
    environment: str

    class Config:
        orm_mode = True
