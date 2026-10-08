"""Run with the build environment's Python (with PyInstaller and rasterio installed)."""

import shutil
import subprocess
import sys
from pathlib import Path

root = Path(__file__).resolve().parents[1]
subprocess.run(
    [
        sys.executable,
        '-m',
        'PyInstaller',
        '--noconfirm',
        '--onedir',
        '--name',
        'gis-worker',
        '--distpath',
        str(root / '.test-artifacts/worker-bundle'),
        '--workpath',
        str(root / '.test-artifacts/worker-build'),
        '--specpath',
        str(root / '.test-artifacts'),
        '--collect-all',
        'rasterio',
        str(root / 'python/worker.py'),
    ],
    check=True,
)
target = root / 'resources/engines/python/gis-worker'
shutil.copytree(root / '.test-artifacts/worker-bundle/gis-worker', target, dirs_exist_ok=True)
print('Bundled Python worker updated:', target)
