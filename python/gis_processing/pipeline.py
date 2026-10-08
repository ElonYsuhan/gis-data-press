"""Validate inputs, invoke converters and atomically commit outputs."""

import json
import os
import shutil
import subprocess
import tempfile
import uuid
from pathlib import Path

from . import runtime
from .imagery import imagery_input, tile_imagery
from .inspection import inspect_data


def process_data(request, engines):
    kind = request['kind']
    if request.get('outputFormat') == 'package' and kind in ('imagery', 'terrain'):
        from .package_pipeline import process_package
        from .terrain import convert_terrain

        return process_package(request, engines, convert_terrain)
    source = Path(request['input']).resolve(strict=True)
    output = Path(request['output']).expanduser().resolve()
    if output == source or (source.is_dir() and source in output.parents):
        raise ValueError('输出目录不能位于输入目录内')
    if output.exists() and (not output.is_dir() or any(output.iterdir())):
        raise ValueError('输出目录必须为空，避免覆盖已有数据')
    if kind == 'imagery':
        engine = runtime.executable(engines.get('gdal'), 'GDAL gdal2tiles')
    elif kind == 'terrain':
        terrain_docker = engines.get('terrain') == 'docker://ctb'
        engine = runtime.executable(
            engines.get('docker') if terrain_docker else engines.get('terrain'),
            'Quantized Mesh CTB',
        )
        help_command = (
            [
                engine,
                'run',
                '--rm',
                '--entrypoint',
                'ctb-tile',
                'ghcr.io/tum-gis/ctb-quantized-mesh:alpine',
                '--help',
            ]
            if terrain_docker
            else [engine, '--help']
        )
        help_result = subprocess.run(help_command, capture_output=True, text=True, timeout=60)
        help_text = help_result.stdout + help_result.stderr
        if 'Mesh' not in help_text and 'mesh' not in help_text:
            raise ValueError('当前 CTB 未声明 Mesh 支持，请安装 Quantized Mesh 分支')
        if request.get('verticalDatum') != 'ellipsoid':
            raise ValueError('请先确认 DEM 为 WGS84 椭球高；正高数据须在外部完成高程基准转换')
    elif kind == 'osgb':
        engine = runtime.executable(engines.get('osgb'), 'OSGB 3dtile')
        if not source.is_dir() or not any(source.rglob('*.osgb')):
            raise ValueError('请选择包含 OSGB 数据的完整目录')
        if not (source / 'metadata.xml').exists() and (
            request.get('longitude') is None or request.get('latitude') is None
        ):
            raise ValueError('没有 metadata.xml，需要填写 WGS84 定位经纬度')
    else:
        raise ValueError('不支持的处理类型')
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='.gis-work-', dir=output.parent) as work:
        work = Path(work)
        stage = work / 'result'
        stage.mkdir()
        runtime.emit('stage', message='预处理数据')
        bounds = None
        if kind == 'imagery':
            byte_input = work / 'rgba.tif'
            byte_input, bounds = imagery_input(source, byte_input, request)
            runtime.emit('stage', message='生成 XYZ 瓦片')
            tile_imagery(engine, byte_input, stage, request)
            if not any(stage.glob('*/*/*.png')):
                raise ValueError('引擎未生成影像瓦片')
        elif kind == 'terrain':
            import rasterio

            with rasterio.open(source) as ds:
                if not ds.crs and not request.get('sourceCrs'):
                    raise ValueError('DEM 缺少坐标系，请填写源 CRS')
                if ds.count != 1:
                    raise ValueError('DEM 必须是单波段高程数据')
                if (ds.units[0] or '').lower() not in (
                    '',
                    'm',
                    'meter',
                    'metre',
                    'meters',
                    'metres',
                ):
                    raise ValueError('DEM 高程单位不是米，请先转换为米制')
            warp = shutil.which('gdalwarp')
            sibling = (
                Path(engines.get('gdal') or '.').with_name(
                    'gdalwarp.exe' if os.name == 'nt' else 'gdalwarp'
                )
                if engines.get('gdal')
                else None
            )
            if not warp and sibling and sibling.is_file():
                warp = str(sibling)
            if not warp:
                raise ValueError('地形预处理需要 gdalwarp，请安装 GDAL')
            normalized = work / 'dem.tif'
            args = [
                warp,
                '-t_srs',
                'EPSG:4326',
                '-r',
                'bilinear',
                '-co',
                'TILED=YES',
                '-co',
                'BIGTIFF=IF_SAFER',
            ]
            if request.get('sourceCrs'):
                args += ['-s_srs', request['sourceCrs']]
            with rasterio.open(source) as ds:
                already_normalized = (
                    ds.crs and ds.crs.to_epsg() == 4326 and not request.get('sourceCrs')
                )
            if already_normalized:
                shutil.copyfile(source, normalized)
            else:
                runtime.run(args + [str(source), str(normalized)], progress=True)
            runtime.emit('stage', message='生成 Quantized Mesh 地形')
            args = [
                engine,
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
                str(stage),
            ]
            if terrain_docker:
                name = 'gis-ctb-' + uuid.uuid4().hex[:12]
                container_args = [
                    engine,
                    'run',
                    '--rm',
                    '--name',
                    name,
                    '-v',
                    str(work) + ':/data',
                    '--entrypoint',
                    'ctb-tile',
                    'ghcr.io/tum-gis/ctb-quantized-mesh:alpine',
                ]
                tile_args = [
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
                    '/data/result',
                ]
                try:
                    runtime.run(container_args + tile_args + ['/data/dem.tif'], progress=True)
                    runtime.run(container_args + tile_args + ['-l', '/data/dem.tif'])
                finally:
                    subprocess.run(
                        [engine, 'rm', '-f', name],
                        stdout=subprocess.DEVNULL,
                        stderr=subprocess.DEVNULL,
                        timeout=15,
                    )
            else:
                runtime.run(args + [str(normalized)], progress=True)
                runtime.run(args + ['-l', str(normalized)])
            bounds = inspect_data(str(normalized))['bounds']
            layer = json.loads((stage / 'layer.json').read_text())
            if layer.get('format') != 'quantized-mesh-1.0' or not any(stage.glob('*/*/*.terrain')):
                raise ValueError('地形成果校验失败')
            layer['bounds'] = bounds
            (stage / 'layer.json').write_text(json.dumps(layer, indent=2))
        else:
            runtime.emit('stage', message='转换 OSGB 场景')
            args = [engine, '-f', 'osgb', '-i', str(source), '-o', str(stage)]
            if request.get('longitude') is not None:
                args += ['-c', json.dumps({'x': request['longitude'], 'y': request['latitude']})]
            runtime.run(args)
            manifest = json.loads((stage / 'tileset.json').read_text())
            if not manifest.get('root') or not manifest.get('asset'):
                raise ValueError('3D Tiles 成果缺少 root 或 asset')
        runtime.emit('stage', message='校验并完成输出')
        metadata = {
            'kind': kind,
            'input': str(source),
            'parameters': request,
            'bounds': bounds,
            'scheme': 'xyz' if kind == 'imagery' else None,
        }
        (stage / 'gis-manifest.json').write_text(json.dumps(metadata, ensure_ascii=False, indent=2))
        # Recheck to avoid replacing files created by another process during conversion.
        if output.exists():
            if any(output.iterdir()):
                raise ValueError('输出目录在加工期间被写入，已停止提交成果')
            output.rmdir()
        stage.rename(output)
    return {'output': str(output), 'kind': kind}
