"""Saved PowerShell scripts for the administrator console

Revision ID: p4q5r6s7t8u9
Revises: m3n4o5p6q7r8
Create Date: 2026-10-17 19:10:00.000000
"""
from datetime import datetime, timezone
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "p4q5r6s7t8u9"
down_revision: Union[str, None] = "m3n4o5p6q7r8"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

SEED = [
    (
        "Clear the print queue",
        "Stops the Print Spooler, empties the queue, starts it again.",
        "Stop-Service -Name Spooler -Force\n"
        "Remove-Item -Path \"$env:SystemRoot\\System32\\spool\\PRINTERS\\*\" -Force -ErrorAction SilentlyContinue\n"
        "Start-Service -Name Spooler\n"
        "Get-Service -Name Spooler | Select-Object Status, Name, DisplayName",
    ),
    (
        "Flush and re-register DNS",
        "Clears the DNS cache and registers the device's name again (the network stays up).",
        "ipconfig /flushdns\n"
        "ipconfig /registerdns\n"
        "Get-DnsClientServerAddress -AddressFamily IPv4 | Where-Object ServerAddresses | "
        "Select-Object InterfaceAlias, ServerAddresses",
    ),
    (
        "Free disk space",
        "Empties Windows and user temp folders, the Windows Update download cache and the recycle bin; "
        "reports what was freed on C:.",
        "$before = (Get-PSDrive C).Free\n"
        "Remove-Item \"$env:SystemRoot\\Temp\\*\" -Recurse -Force -ErrorAction SilentlyContinue\n"
        "Get-ChildItem 'C:\\Users\\*\\AppData\\Local\\Temp' -Directory -ErrorAction SilentlyContinue |\n"
        "  ForEach-Object { Remove-Item \"$($_.FullName)\\*\" -Recurse -Force -ErrorAction SilentlyContinue }\n"
        "Stop-Service -Name wuauserv -Force -ErrorAction SilentlyContinue\n"
        "Remove-Item \"$env:SystemRoot\\SoftwareDistribution\\Download\\*\" -Recurse -Force -ErrorAction SilentlyContinue\n"
        "Start-Service -Name wuauserv -ErrorAction SilentlyContinue\n"
        "Clear-RecycleBin -Force -ErrorAction SilentlyContinue\n"
        "$after = (Get-PSDrive C).Free\n"
        "'Freed {0:N2} GB on C:' -f (($after - $before) / 1GB)",
    ),
    (
        "Last 50 system errors",
        "Critical and error events from the System log, newest first.",
        "Get-WinEvent -FilterHashtable @{ LogName = 'System'; Level = 1, 2 } -MaxEvents 50 -ErrorAction SilentlyContinue |\n"
        "  Format-Table TimeCreated, Id, ProviderName, Message -AutoSize -Wrap",
    ),
    (
        "Disk usage",
        "Size, free space and use of every fixed disk.",
        "Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' |\n"
        "  Select-Object DeviceID,\n"
        "    @{ n = 'Size GB'; e = { [math]::Round($_.Size / 1GB, 1) } },\n"
        "    @{ n = 'Free GB'; e = { [math]::Round($_.FreeSpace / 1GB, 1) } },\n"
        "    @{ n = 'Used %'; e = { [math]::Round(100 - $_.FreeSpace / $_.Size * 100, 1) } } |\n"
        "  Format-Table -AutoSize",
    ),
]


def upgrade() -> None:
    table = op.create_table(
        "console_scripts",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("name", sa.String(120), nullable=False, unique=True),
        sa.Column("description", sa.String(500), nullable=True),
        sa.Column("body", sa.Text(), nullable=False),
        sa.Column("version", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("uses", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("last_used_at", sa.DateTime(), nullable=True),
        sa.Column("created_by", sa.String(128), nullable=True),
        sa.Column("updated_by", sa.String(128), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
    )
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    op.bulk_insert(table, [
        {"name": name, "description": description, "body": body, "version": 1, "uses": 0,
         "created_by": "TECHI", "updated_by": "TECHI", "created_at": now, "updated_at": now}
        for name, description, body in SEED
    ])


def downgrade() -> None:
    op.drop_table("console_scripts")
