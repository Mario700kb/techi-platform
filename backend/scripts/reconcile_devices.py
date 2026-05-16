import os
import sys

BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.append(BACKEND_DIR)
os.chdir(BACKEND_DIR)

from app.db.session import SessionLocal
from app.services.device_status_service import DeviceStatusService


def main() -> None:
    db = SessionLocal()
    try:
        transitioned = DeviceStatusService(db).reconcile_stale_devices()
        print(f"reconciled={transitioned}")
    finally:
        db.close()


if __name__ == "__main__":
    main()
