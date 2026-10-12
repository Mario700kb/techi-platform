from datetime import timedelta
from app.core.time import utcnow
from typing import Any, Dict, Optional

import jwt
# PyJWT replaced python-jose (unmaintained; its ecdsa dependency has an
# advisory with no fix). Same HS256 tokens, so sessions survive the switch.
# Exported under the old name so callers catch one exception type.
from jwt import PyJWTError as JWTError

from app.core.config import settings


def create_access_token(subject: str, expires_delta: Optional[timedelta] = None, extra_claims: Optional[Dict[str, Any]] = None) -> str:
    expire = utcnow() + (expires_delta or timedelta(minutes=settings.ACCESS_TOKEN_EXPIRE_MINUTES))
    to_encode: Dict[str, Any] = {"sub": subject, "exp": expire}
    if extra_claims:
        to_encode.update(extra_claims)
    return jwt.encode(to_encode, settings.SECRET_KEY, algorithm="HS256")


def decode_access_token(token: str) -> dict:
    try:
        payload = jwt.decode(token, settings.SECRET_KEY, algorithms=["HS256"])
        return payload
    except JWTError:
        raise
