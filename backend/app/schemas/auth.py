from pydantic import BaseModel, field_validator

from app.schemas.operator import Operator


class LoginRequest(BaseModel):
    username: str
    password: str


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    expires_in: int
    user: Operator


class ChangePasswordRequest(BaseModel):
    current_password: str
    new_password: str

    @field_validator("new_password")
    @classmethod
    def new_password_strength(cls, v: str) -> str:
        if len(v.strip()) < 8:
            raise ValueError("New password must be at least 8 characters")
        return v

