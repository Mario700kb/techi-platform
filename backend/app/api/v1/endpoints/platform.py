"""Platform Expansion read-only endpoints.

`GET /platform/features` is the single additive endpoint the frontend uses to
know which expansion flags are effective (audit §14). Auth-required; returns
only booleans — flag OFF means the UI renders nothing new.

`GET /platform/components` exposes the Platform Components registry as stable
metadata (deterministic, no DB, tenant-neutral). It only classifies existing
packages/actions — see docs/architecture/PLATFORM-COMPONENTS.md.
"""

from typing import Dict

from fastapi import APIRouter, Depends

from app.core.auth import get_current_operator
from app.models.operator import Operator
from app.platform_core.components import list_components
from app.platform_core.lifecycle import lifecycle_for
from app.platform_core.policy import policy_for
from app.platform_core.flags import FEATURE_DEPENDENCIES, feature_enabled
from app.schemas.platform_component import (
    ComponentLifecycleOut,
    ComponentPolicyOut,
    PlatformComponentOut,
    PlatformComponentsResponse,
)

router = APIRouter()


@router.get("/features", response_model=Dict[str, bool])
def platform_features(_: Operator = Depends(get_current_operator)) -> Dict[str, bool]:
    return {flag: feature_enabled(flag) for flag in FEATURE_DEPENDENCIES}


@router.get("/components", response_model=PlatformComponentsResponse)
def platform_components(
    _: Operator = Depends(get_current_operator),
) -> PlatformComponentsResponse:
    """Platform Components registry metadata. Read-only, deterministic, no DB.

    Lifecycle operations are emitted via the Lifecycle Registry in canonical
    operation order, each with a display label, its existing ActionType (or null),
    and its kind (action vs out-of-band) — so the response is stable and
    self-describing regardless of declaration order."""
    components = []
    for descriptor in list_components():
        lifecycle = [
            ComponentLifecycleOut(
                operation=entry.operation.value,
                label=entry.label,
                action_type=(entry.action_type.value if entry.action_type is not None else None),
                kind=entry.kind.value,
            )
            for entry in lifecycle_for(descriptor.id)
        ]
        policy = policy_for(descriptor.id)
        components.append(
            PlatformComponentOut(
                id=descriptor.id,
                display_name=descriptor.display_name,
                description=descriptor.description,
                icon_key=descriptor.icon_key,
                platforms=list(descriptor.platforms),
                file_types=list(descriptor.file_type_values),
                lifecycle=lifecycle,
                capabilities=sorted(descriptor.capabilities),
                policy=ComponentPolicyOut(
                    desired_source=policy.desired_source.value,
                    policy=policy.policy.value,
                    strategy=policy.strategy.value,
                ),
            )
        )
    return PlatformComponentsResponse(schema_version=1, components=components)
