from fastapi import APIRouter

from app.api.v1.endpoints import agent, deployments, devices, health

api_router = APIRouter()
api_router.include_router(health.router, prefix="", tags=["health"])
api_router.include_router(agent.router, prefix="/agent", tags=["agent"])
api_router.include_router(devices.router, prefix="/devices", tags=["devices"])
api_router.include_router(deployments.router, prefix="/deployments", tags=["deployments"])
