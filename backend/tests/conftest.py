"""Suite-wide test setup.

Several modules build asyncio primitives at *import* time — `realtime_manager`
in `app/websocket/manager.py:173` and the `asyncio.Lock()` in
`AgentCommandChannel.__init__`. On Python 3.9 those bind to the **current**
event loop at construction, and `asyncio.run(...)`, which the websocket tests
use, leaves the thread with no current loop when it returns.

The result was a suite that passed or failed purely on ordering: whichever test
first triggered one of those imports without a current loop died in setup with
"There is no current event loop in thread 'MainThread'". That surfaced as five
collection errors, and `scripts/preflight.sh` fails the deploy gate on any
error at all — so it blocked deploys for a reason unrelated to the code.

Python 3.10+ removed that construction-time binding, so this fixture is inert
on the `python:3.12-slim` image production actually runs. It exists so the suite
is order-independent on any interpreter rather than only on the newest one.
"""
import asyncio

import pytest


@pytest.fixture(autouse=True)
def _current_event_loop():
    """Guarantee every test starts with a current event loop installed."""
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    try:
        yield loop
    finally:
        asyncio.set_event_loop(None)
        loop.close()
