from typing import List, Optional
from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from app.db.session import get_db
from app.models.device import DeviceStatus, DeviceType
from app.schemas.device import Device, DeviceCreate, DeviceUpdate
from app.services.device_service import DeviceService

router = APIRouter()


@router.get("/", response_model=List[Device])
def read_devices(
    db: Session = Depends(get_db),
    skip: int = 0,
    limit: int = Query(default=100, le=1000),
    status: Optional[DeviceStatus] = None,
    device_type: Optional[DeviceType] = None,
    client_id: Optional[int] = None,
    group_id: Optional[int] = None,
    search: Optional[str] = None,
):
    """
    Retrieve devices with optional filtering and search.
    """
    service = DeviceService(db)
    devices = service.get_devices(
        skip=skip,
        limit=limit,
        status=status,
        device_type=device_type,
        client_id=client_id,
        group_id=group_id,
        search=search,
    )
    return devices


@router.get("/count")
def read_devices_count(
    db: Session = Depends(get_db),
    status: Optional[DeviceStatus] = None,
    device_type: Optional[DeviceType] = None,
    client_id: Optional[int] = None,
    group_id: Optional[int] = None,
    search: Optional[str] = None,
):
    """
    Get count of devices with optional filtering.
    """
    service = DeviceService(db)
    count = service.get_devices_count(
        status=status,
        device_type=device_type,
        client_id=client_id,
        group_id=group_id,
        search=search,
    )
    return {"count": count}


@router.post("/", response_model=Device)
def create_device(
    *,
    db: Session = Depends(get_db),
    device_in: DeviceCreate,
):
    """
    Create new device.
    """
    service = DeviceService(db)
    try:
        device = service.create_device(device_in)
        return device
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.get("/{device_id}", response_model=Device)
def read_device(
    *,
    db: Session = Depends(get_db),
    device_id: int,
):
    """
    Get device by ID.
    """
    service = DeviceService(db)
    device = service.get_device(device_id)
    if not device:
        raise HTTPException(status_code=404, detail="Device not found")
    return device


@router.put("/{device_id}", response_model=Device)
def update_device(
    *,
    db: Session = Depends(get_db),
    device_id: int,
    device_in: DeviceUpdate,
):
    """
    Update a device.
    """
    service = DeviceService(db)
    device = service.update_device(device_id, device_in)
    if not device:
        raise HTTPException(status_code=404, detail="Device not found")
    return device


@router.delete("/{device_id}", response_model=Device)
def delete_device(
    *,
    db: Session = Depends(get_db),
    device_id: int,
):
    """
    Delete a device.
    """
    service = DeviceService(db)
    device = service.delete_device(device_id)
    if not device:
        raise HTTPException(status_code=404, detail="Device not found")
    return device
