"""Platform Core — foundation of the Platform Expansion (Phase 0).

Contract: docs/reference/PLATFORM-EXPANSION-AUDIT.md (DESIGN LOCKED).

This package is intentionally imported by NOTHING in the existing codebase
during Phase 0: it is dark infrastructure. Wiring into services happens in
later phases, gated by the feature flags in app.core.config.
"""

from app.platform_core.capabilities import (
    KNOWN_CAPABILITIES,
    is_known_capability,
    normalize_capabilities,
)
from app.platform_core.components import (
    COMPONENT_REGISTRY,
    ComponentDescriptor,
    ComponentHealth,
    ComponentState,
    LifecycleOperation,
    STATUS_LABELS,
    build_component_state,
    component_for_file_type,
    components_for_platform,
    derive_health,
    get_component,
    list_components,
    list_file_types_for_component,
    status_label,
)
from app.platform_core.action_resolver import (
    ComponentActionError,
    ComponentActionErrorCode,
    ResolvedComponentAction,
    can_resolve,
    parse_operation,
    resolve_component_action,
)
from app.platform_core.flags import FEATURE_DEPENDENCIES, feature_enabled
from app.platform_core.lifecycle import (
    ACTION_TO_LIFECYCLE,
    LIFECYCLE_LABELS,
    LifecycleEntry,
    LifecycleKind,
    action_for,
    component_operation_for_action,
    lifecycle_for,
    operations_for,
    validate_lifecycle_registry,
)
from app.platform_core.policy import (
    COMPONENT_POLICY_REGISTRY,
    ComponentPolicy,
    ComponentPolicyDescriptor,
    DeploymentStrategy,
    DesiredSource,
    list_policies,
    policy_for,
    validate_policy_registry,
)
from app.platform_core.registry import (
    DEFAULT_PLATFORM_ID,
    PLATFORM_REGISTRY,
    PlatformDescriptor,
    is_known_platform,
    resolve_platform,
)

__all__ = [
    "KNOWN_CAPABILITIES",
    "is_known_capability",
    "normalize_capabilities",
    "COMPONENT_REGISTRY",
    "ComponentDescriptor",
    "ComponentHealth",
    "ComponentState",
    "LifecycleOperation",
    "build_component_state",
    "component_for_file_type",
    "components_for_platform",
    "derive_health",
    "get_component",
    "list_components",
    "list_file_types_for_component",
    "STATUS_LABELS",
    "status_label",
    "ACTION_TO_LIFECYCLE",
    "LIFECYCLE_LABELS",
    "LifecycleEntry",
    "LifecycleKind",
    "action_for",
    "component_operation_for_action",
    "lifecycle_for",
    "operations_for",
    "validate_lifecycle_registry",
    "COMPONENT_POLICY_REGISTRY",
    "ComponentPolicy",
    "ComponentPolicyDescriptor",
    "DeploymentStrategy",
    "DesiredSource",
    "list_policies",
    "policy_for",
    "validate_policy_registry",
    "ComponentActionError",
    "ComponentActionErrorCode",
    "ResolvedComponentAction",
    "can_resolve",
    "parse_operation",
    "resolve_component_action",
    "FEATURE_DEPENDENCIES",
    "feature_enabled",
    "DEFAULT_PLATFORM_ID",
    "PLATFORM_REGISTRY",
    "PlatformDescriptor",
    "is_known_platform",
    "resolve_platform",
]
