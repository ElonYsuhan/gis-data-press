"""One-shot JSON worker entry point; implementation lives in gis_processing."""

import json
import signal
import sys
import traceback

from gis_processing import runtime
from gis_processing.inspection import inspect_data
from gis_processing.pipeline import process_data


def main():
    payload = json.load(sys.stdin)
    if payload['action'] == 'inspect':
        result = inspect_data(payload['path'])
    elif payload['action'] == 'process':
        result = process_data(payload['request'], payload['engines'])
    else:
        raise ValueError('未知 worker 操作')
    runtime.emit('result', value=result)


def terminate(signum, frame):
    raise SystemExit(130)


if __name__ == '__main__':
    signal.signal(signal.SIGTERM, terminate)
    try:
        main()
    except Exception as error:
        runtime.emit('error', message=str(error))
        traceback.print_exc(file=sys.stderr)
        sys.exit(1)
