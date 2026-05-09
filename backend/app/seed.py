#!/usr/bin/env python3
"""
Seed script for TECHI Platform development data.
Run with: python -m app.seed
"""
import sys
from pathlib import Path

# Add the backend directory to the Python path
backend_dir = Path(__file__).parent
sys.path.insert(0, str(backend_dir))

from datetime import datetime, timedelta
from sqlalchemy.orm import Session

from app.db.session import SessionLocal
from app.models.client import Client
from app.models.device_group import DeviceGroup
from app.models.device import Device, DeviceType, DeviceStatus
from app.models.operator import Operator


def create_sample_data(db: Session):
    """Create sample data for development."""

    # Create sample clients
    clients_data = [
        {"name": "ADPascucci", "description": "ADPascucci client"},
        {"name": "TopExpress", "description": "TopExpress client"},
        {"name": "TechCorp", "description": "TechCorp client"},
    ]

    clients = []
    for client_data in clients_data:
        client = Client(**client_data)
        db.add(client)
        clients.append(client)

    db.commit()

    # Create sample device groups
    groups_data = [
        {"name": "Servers", "client_id": clients[0].id},  # ADPascucci servers
        {"name": "Workstations", "client_id": clients[0].id},  # ADPascucci workstations
        {"name": "Servers", "client_id": clients[1].id},  # TopExpress servers
        {"name": "Workstations", "client_id": clients[1].id},  # TopExpress workstations
    ]

    groups = []
    for group_data in groups_data:
        group = DeviceGroup(**group_data)
        db.add(group)
        groups.append(group)

    db.commit()

    # Create sample devices
    devices_data = [
        {
            "rustdesk_id": "123456789",
            "hostname": "adp-server-01",
            "current_user": "administrator",
            "domain": "adp.local",
            "public_ip": "203.0.113.1",
            "local_ip": "192.168.1.10",
            "os_name": "Windows",
            "os_version": "10 Pro",
            "platform": "Windows",
            "device_type": DeviceType.SERVER,
            "status": DeviceStatus.ONLINE,
            "client_id": clients[0].id,
            "group_id": groups[0].id,
            "cpu": "Intel Core i7-8700K",
            "ram": "32GB",
            "storage": "500GB SSD",
            "last_seen": datetime.utcnow(),
        },
        {
            "rustdesk_id": "987654321",
            "hostname": "adp-workstation-01",
            "current_user": "john.doe",
            "domain": "adp.local",
            "public_ip": "203.0.113.2",
            "local_ip": "192.168.1.20",
            "os_name": "Windows",
            "os_version": "11 Pro",
            "platform": "Windows",
            "device_type": DeviceType.CLIENT,
            "status": DeviceStatus.ONLINE,
            "client_id": clients[0].id,
            "group_id": groups[1].id,
            "cpu": "AMD Ryzen 5 5600X",
            "ram": "16GB",
            "storage": "1TB SSD",
            "last_seen": datetime.utcnow(),
        },
        {
            "rustdesk_id": "555666777",
            "hostname": "top-server-01",
            "current_user": "admin",
            "domain": "topexpress.local",
            "public_ip": "203.0.113.3",
            "local_ip": "192.168.2.10",
            "os_name": "Ubuntu",
            "os_version": "22.04 LTS",
            "platform": "Linux",
            "device_type": DeviceType.SERVER,
            "status": DeviceStatus.OFFLINE,
            "client_id": clients[1].id,
            "group_id": groups[2].id,
            "cpu": "Intel Xeon E5-2650",
            "ram": "64GB",
            "storage": "2TB SSD",
            "last_seen": datetime.utcnow() - timedelta(hours=2),
        },
        {
            "rustdesk_id": "111222333",
            "hostname": "top-workstation-01",
            "current_user": "jane.smith",
            "domain": "topexpress.local",
            "public_ip": "203.0.113.4",
            "local_ip": "192.168.2.20",
            "os_name": "macOS",
            "os_version": "Sonoma 14.1",
            "platform": "macOS",
            "device_type": DeviceType.CLIENT,
            "status": DeviceStatus.ONLINE,
            "client_id": clients[1].id,
            "group_id": groups[3].id,
            "cpu": "Apple M2",
            "ram": "16GB",
            "storage": "512GB SSD",
            "last_seen": datetime.utcnow(),
        },
        {
            "rustdesk_id": "444555666",
            "hostname": "unassigned-device",
            "current_user": "user",
            "public_ip": "203.0.113.5",
            "local_ip": "192.168.3.10",
            "os_name": "Windows",
            "os_version": "10 Home",
            "platform": "Windows",
            "device_type": DeviceType.UNASSIGNED,
            "status": DeviceStatus.OFFLINE,
            "cpu": "Intel Core i5-10400",
            "ram": "8GB",
            "storage": "256GB SSD",
            "last_seen": datetime.utcnow() - timedelta(days=1),
        },
    ]

    for device_data in devices_data:
        device = Device(**device_data)
        db.add(device)

    # Create sample operator
    operator = Operator(
        username="admin",
        email="admin@techiplatform.com",
        hashed_password="hashed_password_placeholder",  # In real app, this would be properly hashed
        is_superuser=True,
    )
    db.add(operator)

    db.commit()
    print("Sample data created successfully!")


def main():
    db = SessionLocal()
    try:
        create_sample_data(db)
    finally:
        db.close()


if __name__ == "__main__":
    main()
