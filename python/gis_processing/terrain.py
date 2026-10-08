"""CTB adapter reading the retained geographic COG without a second raster copy."""

import json
import subprocess
import uuid

from . import runtime
from .inspection import inspect_data


def convert_terrain(master, stage, request, engines, directory):
    docker = engines.get('terrain') == 'docker://ctb'
    engine = runtime.executable(
        engines.get('docker') if docker else engines.get('terrain'), 'Quantized Mesh CTB'
    )
    prefix = [engine]
    name = 'geopress-ctb-' + uuid.uuid4().hex[:12]
    if docker:
        prefix += [
            'run',
            '--rm',
            '--name',
            name,
            '-v',
            str(directory) + ':/data',
            '--entrypoint',
            'ctb-tile',
            'ghcr.io/tum-gis/ctb-quantized-mesh:alpine',
        ]
    help_result = subprocess.run(prefix + ['--help'], capture_output=True, text=True, timeout=60)
    if 'mesh' not in (help_result.stdout + help_result.stderr).lower():
        raise ValueError('当前 CTB 引擎不支持 Quantized Mesh')
    stage.mkdir(exist_ok=True)
    args = [
        '-f',
        'Mesh',
        '-C',
        '-N',
        '-c',
        str(request['workers']),
        '-s',
        str(request['maxZoom']),
        '-e',
        str(request['minZoom']),
        '-o',
        '/data/tiles' if docker else str(stage),
    ]
    source = '/data/master.tif' if docker else str(master)
    try:
        runtime.run(prefix + args + [source], progress=True)
        runtime.run(prefix + args + ['-l', source])
    finally:
        if docker:
            subprocess.run(
                [engine, 'rm', '-f', name],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                timeout=15,
            )
    layer = json.loads((stage / 'layer.json').read_text())
    if layer.get('format') != 'quantized-mesh-1.0' or not any(stage.glob('*/*/*.terrain')):
        raise ValueError('CTB 地形成果校验失败')
    layer['bounds'] = inspect_data(str(master))['bounds']
    (stage / 'layer.json').write_text(json.dumps(layer, indent=2))
