"""Platform Expansion read-only endpoints.

`GET /platform/features` is the single additive endpoint the frontend uses to
know which expansion flags are effective (audit §14). Auth-required; returns
only booleans — flag OFF means the UI renders nothing new.
"""

from typing import Dict

from fastapi import APIRouter, Depends

from app.core.auth import get_current_operator
from app.models.operator import Operator
from app.platform_core.flags import FEATURE_DEPENDENCIES, feature_enabled

router = APIRouter()


@router.get("/features", response_model=Dict[str, bool])
def platform_features(_: Operator = Depends(get_current_operator)) -> Dict[str, bool]:
    return {flag: feature_enabled(flag) for flag in FEATURE_DEPENDENCIES}
