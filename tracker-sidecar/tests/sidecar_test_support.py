import importlib
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))


def implementation(test, name):
    test.assertTrue((ROOT / (name.replace('.', '/') + '.py')).is_file(),
                    'Required tracker implementation is missing: ' + name)
    return importlib.import_module(name)


async def receive_type(ws, kind):
    import asyncio
    import json
    for _ in range(30):
        message = json.loads(await asyncio.wait_for(ws.recv(), 3))
        if message['type'] == kind:
            return message
    raise AssertionError('Expected message type was not received')
