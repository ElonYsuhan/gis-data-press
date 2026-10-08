"""Durable processing stages; retained COG master and atomic single-file publication."""

import hashlib
import json
import os
import shutil
from pathlib import Path

from . import runtime
from .fusion import build_master, input_paths
from .packages import write_imagery, write_terrain


def process_package(request, engines, terrain_converter):
    sources = input_paths(request)
    output = Path(request['output']).expanduser().resolve()
    expected = '.mbtiles' if request['kind'] == 'imagery' else '.terrain.sqlite'
    if not str(output).lower().endswith(expected):
        raise ValueError(f'成果文件名必须以 {expected} 结尾')
    if output.exists():
        raise ValueError('成果文件已经存在，请使用新的文件名，避免覆盖发布版本')
    if request['kind'] == 'terrain' and request.get('verticalDatum') != 'ellipsoid':
        raise ValueError('请先确认所有 DEM 为米制 WGS84 椭球高；正高数据需要先转换高程基准')
    # Fingerprints invalidate checkpoints when input content, parameters or processing version change.
    identity_request = {
        key: value for key, value in request.items() if key not in ('workers', 'resume')
    }
    identity = {
        'version': 1,
        'engines': engines,
        'sources': [
            {
                'path': value,
                'size': Path(value).stat().st_size,
                'mtimeNs': Path(value).stat().st_mtime_ns,
            }
            for value in sources
        ],
        'parameters': identity_request,
    }
    fingerprint = hashlib.sha256(json.dumps(identity, sort_keys=True).encode()).hexdigest()
    directory = output.with_name(output.name + '.sources')
    state_file = directory / 'checkpoint.json'
    state = {'fingerprint': fingerprint, 'master': False, 'tiles': False, 'complete': False}
    if directory.exists():
        if not state_file.exists():
            raise ValueError('母数据目录已存在且不属于此任务，请更换成果文件名')
        previous = json.loads(state_file.read_text())
        if previous['fingerprint'] != fingerprint:
            raise ValueError('输入或融合参数已经变化，请使用新的成果文件名；原母数据保留')
        state = previous
        runtime.emit('log', message='恢复相同输入版本的处理记录，跳过已完成阶段')
    else:
        directory.mkdir(parents=True)

    def checkpoint():
        candidate = directory / 'checkpoint.json.tmp'
        candidate.write_text(json.dumps(state, indent=2))
        candidate.replace(state_file)

    checkpoint()
    master = directory / 'master.tif'
    if not state['master'] or not master.exists():
        runtime.emit('stage', message='检查坐标系、有效值并融合输入')
        master, bounds = build_master(sources, directory, request)
        state.update(master=True, bounds=bounds)
        checkpoint()
    bounds = state['bounds']
    manifest = {**identity, 'kind': request['kind'], 'bounds': bounds, 'fingerprint': fingerprint}
    partial = directory / 'package.partial.sqlite'
    if request['kind'] == 'imagery':
        runtime.emit('stage', message='生成影像瓦片并写入 MBTiles')
        write_imagery(master, partial, request, bounds, manifest)
    else:
        stage = directory / 'tiles'
        if not state['tiles']:
            runtime.emit('stage', message='生成 Quantized Mesh 地形')
            terrain_converter(master, stage, request, engines, directory)
            state['tiles'] = True
            checkpoint()
        runtime.emit('stage', message='打包 Quantized Mesh SQLite')
        write_terrain(stage, partial, manifest)
    # Recheck source versions before committing; a running download must not become a published artifact.
    for entry in identity['sources']:
        info = Path(entry['path']).stat()
        if info.st_size != entry['size'] or info.st_mtime_ns != entry['mtimeNs']:
            raise ValueError('加工期间输入文件发生变化，成果未提交，请换新文件名重新处理')
    runtime.emit('stage', message='校验单文件成果并提交')
    # Hard-link commit is atomic and refuses to overwrite a concurrently created output.
    with partial.open('rb') as handle:
        os.fsync(handle.fileno())
    os.link(partial, output)
    partial.unlink()
    state['complete'] = True
    checkpoint()
    shutil.rmtree(directory / 'tiles', ignore_errors=True)
    runtime.emit('log', message=f'母数据保留：{master}；单文件成果：{output}')
    return {'output': str(output), 'kind': request['kind'], 'master': str(master)}
