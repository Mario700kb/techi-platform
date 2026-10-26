import re
from typing import Optional

# From this version the Windows agent reports installed RAM (as Windows shows
# it under System > About) and other platforms round to the nearest GB.
INSTALLED_RAM_AGENT_VERSION = (2, 1, 47)

_WHOLE_GB = re.compile(r"^(\d+) GB$")
_MIB = 1024 ** 2
_GIB = 1024 ** 3


def installed_ram_label(ram: Optional[str], agent_version: Optional[str]) -> Optional[str]:
    """The memory as people know it: "4 GB", "512 MB".

    Agents before 2.1.47 sent the memory the OS can use, rounded down to a
    whole GB: a PC with 4 GB installed and 3.8 GB usable showed "3 GB". Usable
    memory is always a little below what is installed and never a whole GB, so
    the size is the next GB up; "0 GB" was under 1 GB. MikroTik sends bytes."""
    if not ram:
        return ram
    text = ram.strip()
    if text.isdigit():
        size = int(text)
        if size >= _GIB:
            return f"{round(size / _GIB)} GB"
        return f"{round(size / _MIB)} MB" if size >= _MIB else ram
    if _reports_installed(agent_version):
        return ram
    match = _WHOLE_GB.match(text)
    if not match:
        return ram
    whole = int(match.group(1))
    return f"{whole + 1} GB" if whole >= 1 else "<1 GB"


def _reports_installed(agent_version: Optional[str]) -> bool:
    try:
        return tuple(int(p) for p in (agent_version or "").strip().split(".")) >= INSTALLED_RAM_AGENT_VERSION
    except ValueError:
        return False
