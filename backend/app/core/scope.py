"""
AllowedScope — lightweight, immutable value object that carries the set of
client IDs, group IDs, and device IDs an operator is allowed to see.

None means "unrestricted" (owner / admin).
An AllowedScope with all-empty sets means "no access at all."
"""

from dataclasses import dataclass, field
from typing import FrozenSet, Optional


@dataclass(frozen=True)
class AllowedScope:
    client_ids: FrozenSet[int] = field(default_factory=frozenset)
    group_ids: FrozenSet[int] = field(default_factory=frozenset)
    device_ids: FrozenSet[int] = field(default_factory=frozenset)

    def is_empty(self) -> bool:
        return not self.client_ids and not self.group_ids and not self.device_ids


def device_in_scope(
    device_client_id: Optional[int],
    device_group_id: Optional[int],
    device_id: int,
    scope: Optional[AllowedScope],
) -> bool:
    """Return True if the device is visible under *scope*.

    A None scope means unrestricted — always True.
    """
    if scope is None:
        return True
    if device_client_id and device_client_id in scope.client_ids:
        return True
    if device_group_id and device_group_id in scope.group_ids:
        return True
    if device_id in scope.device_ids:
        return True
    return False
