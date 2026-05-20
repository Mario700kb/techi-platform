from fastapi import APIRouter

from app.api.v1.endpoints import actions, agent, agent_packages, alerts, audit, auth, bootstrap, clients, deployments, devices, enrollment_bootstrap, enrollment_tokens, groups, health, operator_scopes, operators

api_router = APIRouter()
api_router.include_router(health.router, prefix="", tags=["health"])
api_router.include_router(auth.router, prefix="/auth", tags=["auth"])
api_router.include_router(agent.router, prefix="/agent", tags=["agent"])
api_router.include_router(bootstrap.router, prefix="/bootstrap", tags=["bootstrap"])
api_router.include_router(clients.router, prefix="/clients", tags=["clients"])
api_router.include_router(devices.router, prefix="/devices", tags=["devices"])
api_router.include_router(groups.router, prefix="/groups", tags=["groups"])
api_router.include_router(deployments.router, prefix="/deployments", tags=["deployments"])
api_router.include_router(alerts.router, prefix="/alerts", tags=["alerts"])
api_router.include_router(enrollment_tokens.router, prefix="/enrollment-tokens", tags=["enrollment-tokens"])
api_router.include_router(enrollment_bootstrap.router, prefix="/enrollment-bootstrap", tags=["enrollment-bootstrap"])
api_router.include_router(agent_packages.router, prefix="/agent-packages", tags=["agent-packages"])
api_router.include_router(operators.router, prefix="/operators", tags=["operators"])
api_router.include_router(operator_scopes.router, prefix="/operators", tags=["operator-scopes"])
api_router.include_router(actions.router, prefix="", tags=["actions"])
api_router.include_router(audit.router, prefix="/audit", tags=["audit"])
