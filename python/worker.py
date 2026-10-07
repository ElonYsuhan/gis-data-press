"""One-shot JSON worker. Resource data stays in user-owned directories."""
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import tempfile
import traceback
import uuid
import re
import time
import math
import codecs


def emit(event, **values):
    print(json.dumps({'event': event, **values}, ensure_ascii=False), flush=True)


def inspect_data(filename):
    source = Path(filename).resolve(strict=True)
    if source.is_dir():
        count = sum(1 for p in source.rglob('*.osgb') if p.is_file() and not p.is_symlink())
        if not count:
            raise ValueError('目录中没有 OSGB 数据')
        return {'path': str(source), 'type': 'OSGB', 'files': count,
                'warnings': [] if (source / 'metadata.xml').exists() else ['没有 metadata.xml，需要填写 WGS84 定位经纬度']}
    if source.suffix.lower() not in ('.tif', '.tiff', '.vrt'):
        return {'path': str(source), 'type': source.suffix.upper().lstrip('.'),
                'size': source.stat().st_size, 'warnings': ['此文件可作为静态资源发布；加工模块支持 TIFF、VRT 和 OSGB 目录']}
    import rasterio
    from rasterio.warp import transform_bounds
    with rasterio.open(source) as ds:
        warnings = []
        if not ds.crs:
            warnings.append('缺少坐标系，需要在任务中填写源 CRS')
        if ds.count == 1:
            warnings.append('高程基准无法仅凭 TIFF 自动确认；地形加工前请确认米制椭球高')
        bounds = list(transform_bounds(ds.crs, 'EPSG:4326', *ds.bounds)) if ds.crs else list(ds.bounds)
        projected = transform_bounds(ds.crs, 'EPSG:3857', *ds.bounds) if ds.crs else None
        resolution = max((projected[2]-projected[0])/ds.width, (projected[3]-projected[1])/ds.height) if projected else None
        latitude = (bounds[1]+bounds[3])/2
        metres = resolution * math.cos(math.radians(latitude)) if resolution else None
        recommended = {'imagery': max(0, min(22, round(math.log2(156543.033928/resolution)))),
                       'terrain': max(0, min(22, math.ceil(math.log2(313086.067856/metres))))} if resolution and metres and resolution > 0 and metres > 0 and math.isfinite(resolution) and math.isfinite(metres) else None
        return {'path': str(source), 'type': 'GeoTIFF' if source.suffix.lower() != '.vrt' else 'VRT',
                'size': source.stat().st_size, 'width': ds.width, 'height': ds.height, 'bands': ds.count,
                'crs': ds.crs.to_string() if ds.crs else '', 'bounds': bounds,
                'nodata': ds.nodata if ds.nodata is None or (ds.nodata == ds.nodata and abs(ds.nodata) != float('inf')) else None,
                'dtype': ds.dtypes[0], 'units': ds.units[0] or '', 'warnings': warnings,
                'pixelSize': list(ds.res), 'recommendedZoom': recommended}


def executable(value, label):
    found = shutil.which(value) if value else None
    if not found:
        raise ValueError(f'缺少 {label} 引擎，请在设置中配置可执行文件')
    return found


def run(args, progress=False):
    emit('log', message='执行: ' + ' '.join(map(str, args)))
    env = dict(os.environ, GDAL_CACHEMAX='256', PYTHONUNBUFFERED='1')
    process = subprocess.Popen(list(map(str, args)), stdout=subprocess.PIPE, stderr=subprocess.STDOUT, env=env)
    decoder = codecs.getincrementaldecoder('utf-8')('replace')
    pending = ''; progress_tail = ''; last_percent = -1
    while True:
        chunk = os.read(process.stdout.fileno(), 4096)
        if not chunk:
            break
        text = decoder.decode(chunk)
        pending += text
        progress_tail = (progress_tail + text)[-4096:]
        if progress:
            if 'Generating Overview Tiles' in text:
                emit('stage', message='生成低层级瓦片');last_percent = -1;progress_tail = text
            for match in re.finditer(r'(?<!\d)(\d{1,3})(?=\.{3}| - done|%)', progress_tail):
                value = int(match.group(1))
                if 0 <= value <= 100 and value > last_percent:
                    last_percent = value
                    emit('progress', percent=value, label='引擎阶段进度')
        lines = re.split(r'[\r\n]', pending)
        pending = lines.pop()
        for line in lines:
            if line.strip():
                emit('log', message=line.strip()[:4000])
        if len(pending) > 8000:
            emit('log', message=pending[:4000]);pending = pending[-4000:]
    if pending.strip():
        emit('log', message=pending.strip()[:4000])
    process.stdout.close()
    code = process.wait()
    if code:
        raise RuntimeError(f'转换引擎退出码 {code}，请查看日志')


def imagery_input(source, destination, request):
    import rasterio
    from rasterio.enums import ColorInterp
    from rasterio.warp import transform_bounds
    with rasterio.open(source) as ds:
        expected = (ColorInterp.red, ColorInterp.green, ColorInterp.blue)
        if (not request.get('scale') and not request.get('sourceCrs') and ds.crs and
                ds.count in (3, 4) and all(t == 'uint8' for t in ds.dtypes) and
                ds.colorinterp[:3] == expected and
                (ds.count == 3 or ds.colorinterp[3] == ColorInterp.alpha)):
            emit('log', message='直接读取 Byte RGB/RGBA 原图，跳过整份临时影像转写')
            return source, list(transform_bounds(ds.crs, 'EPSG:4326', *ds.bounds))
    return destination, prepare_imagery(source, destination, request)


def tile_imagery(engine, source, stage, request):
    candidate = Path(engine).with_name('gdal.exe' if os.name == 'nt' else 'gdal')
    native = None
    if Path(engine).name.startswith('gdal2tiles') and candidate.is_file():
        try:
            help_result = subprocess.run([str(candidate), 'raster', 'tile', '--help'], capture_output=True, text=True, timeout=10)
            if help_result.returncode == 0 and '--num-threads' in help_result.stdout:
                native = (str(candidate), help_result.stdout)
        except (OSError, subprocess.TimeoutExpired):
            pass
    if native:
        command, help_text = native
        args = [command, 'raster', 'tile', '--min-zoom', str(request['minZoom']), '--max-zoom', str(request['maxZoom']),
                '--convention', 'xyz', '--num-threads', str(request['workers']), '--resampling', 'average',
                '--webviewer', 'none', '--co', 'ZLEVEL=1']
        if '--parallel-method' in help_text:
            args += ['--parallel-method', 'spawn']
        emit('log', message=f"使用 GDAL 原生切片，{request['workers']} 个并行工作进程，PNG 快速无损压缩")
        run(args + [str(source), str(stage)], progress=True)
    else:
        run([engine, '--xyz', '-p', 'mercator', '-z', f"{request['minZoom']}-{request['maxZoom']}",
             '--processes', str(request['workers']), '-w', 'none', str(source), str(stage)], progress=True)


def prepare_imagery(source, destination, request):
    import numpy as np
    import rasterio
    from rasterio.enums import ColorInterp, Resampling
    from rasterio.warp import transform_bounds
    with rasterio.open(source) as ds:
        crs = request.get('sourceCrs') or ds.crs
        if not crs:
            raise ValueError('输入没有坐标系，请填写源 CRS')
        if ds.count not in (1, 3, 4):
            raise ValueError('第一版支持单波段或 RGB/RGBA 影像，请先选择波段生成 1、3 或 4 波段文件')
        indices = [1, 1, 1] if ds.count == 1 else [1, 2, 3]
        if ds.colorinterp[0] == ColorInterp.palette:
            raise ValueError('第一版不转换调色板 TIFF，请先转换为 RGB 影像')
        limits = []
        if ds.dtypes[0] != 'uint8' and not request.get('scale'):
            raise ValueError('非 Byte 影像需要启用百分位拉伸')
        for index in indices:
            if not request.get('scale'):
                limits.append((0, 255));continue
            sample = ds.read(index, out_shape=(min(ds.height, 512), min(ds.width, 512)), masked=True,
                             resampling=Resampling.nearest).compressed()
            lo, hi = np.percentile(sample, [2, 98]) if sample.size else (0, 1)
            limits.append((float(lo), float(hi) if hi > lo else float(lo) + 1))
        profile = ds.profile.copy()
        profile.update(driver='GTiff', dtype='uint8', count=4, crs=crs, nodata=None,
                       tiled=True, blockxsize=256, blockysize=256, compress='deflate', zlevel=1, BIGTIFF='IF_SAFER')
        # Remove incompatible source creation options (e.g. YCbCr / palette metadata).
        for key in ('photometric', 'interleave'):
            profile.pop(key, None)
        with rasterio.open(destination, 'w', **profile) as out:
            out.colorinterp = (ColorInterp.red, ColorInterp.green, ColorInterp.blue, ColorInterp.alpha)
            total = math.ceil(ds.width/256) * math.ceil(ds.height/256)
            last_update = 0
            for completed, (_, window) in enumerate(out.block_windows(1), 1):
                for target, (index, limits_) in enumerate(zip(indices, limits), 1):
                    data = ds.read(index, window=window)
                    if request.get('scale'): data = data.astype('float32')
                    if request.get('scale'):
                        lo, hi = limits_
                        data = (data - lo) * (255 / (hi - lo))
                    out.write(np.nan_to_num(np.clip(data, 0, 255)).astype('uint8'), target, window=window)
                out.write(ds.dataset_mask(window=window), 4, window=window)
                now = time.monotonic()
                if now-last_update >= .3 or completed == total:
                    emit('progress', percent=100*completed/total, label=f'预处理数据块 {completed}/{total}')
                    last_update = now
        return list(transform_bounds(crs, 'EPSG:4326', *ds.bounds))


def process_data(request, engines):
    kind = request['kind']
    source = Path(request['input']).resolve(strict=True)
    output = Path(request['output']).expanduser().resolve()
    if output == source or (source.is_dir() and source in output.parents):
        raise ValueError('输出目录不能位于输入目录内')
    if output.exists() and (not output.is_dir() or any(output.iterdir())):
        raise ValueError('输出目录必须为空，避免覆盖已有数据')
    if kind == 'imagery':
        engine = executable(engines.get('gdal'), 'GDAL gdal2tiles')
    elif kind == 'terrain':
        terrain_docker = engines.get('terrain') == 'docker://ctb'
        engine = executable(engines.get('docker') if terrain_docker else engines.get('terrain'), 'Quantized Mesh CTB')
        help_command = [engine, 'run', '--rm', '--entrypoint', 'ctb-tile', 'ghcr.io/tum-gis/ctb-quantized-mesh:alpine', '--help'] if terrain_docker else [engine, '--help']
        help_result = subprocess.run(help_command, capture_output=True, text=True, timeout=60)
        help_text = help_result.stdout + help_result.stderr
        if 'Mesh' not in help_text and 'mesh' not in help_text:
            raise ValueError('当前 CTB 未声明 Mesh 支持，请安装 Quantized Mesh 分支')
        if request.get('verticalDatum') != 'ellipsoid':
            raise ValueError('请先确认 DEM 为 WGS84 椭球高；正高数据须在外部完成高程基准转换')
    elif kind == 'osgb':
        engine = executable(engines.get('osgb'), 'OSGB 3dtile')
        if not source.is_dir() or not any(source.rglob('*.osgb')):
            raise ValueError('请选择包含 OSGB 数据的完整目录')
        if not (source / 'metadata.xml').exists() and (request.get('longitude') is None or request.get('latitude') is None):
            raise ValueError('没有 metadata.xml，需要填写 WGS84 定位经纬度')
    else:
        raise ValueError('不支持的处理类型')
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='.gis-work-', dir=output.parent) as work:
        work = Path(work)
        stage = work / 'result'
        stage.mkdir()
        emit('stage', message='预处理数据')
        bounds = None
        if kind == 'imagery':
            byte_input = work / 'rgba.tif'
            byte_input, bounds = imagery_input(source, byte_input, request)
            emit('stage', message='生成 XYZ 瓦片')
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
                if (ds.units[0] or '').lower() not in ('', 'm', 'meter', 'metre', 'meters', 'metres'):
                    raise ValueError('DEM 高程单位不是米，请先转换为米制')
            warp = shutil.which('gdalwarp')
            sibling = Path(engines.get('gdal') or '.').with_name('gdalwarp.exe' if os.name == 'nt' else 'gdalwarp') if engines.get('gdal') else None
            if not warp and sibling and sibling.is_file():
                warp = str(sibling)
            if not warp:
                raise ValueError('地形预处理需要 gdalwarp，请安装 GDAL')
            normalized = work / 'dem.tif'
            args = [warp, '-t_srs', 'EPSG:4326', '-r', 'bilinear', '-co', 'TILED=YES', '-co', 'BIGTIFF=IF_SAFER']
            if request.get('sourceCrs'):
                args += ['-s_srs', request['sourceCrs']]
            run(args + [str(source), str(normalized)], progress=True)
            emit('stage', message='生成 Quantized Mesh 地形')
            args = [engine, '-f', 'Mesh', '-C', '-N', '-c', str(request['workers']), '-s', str(request['maxZoom']), '-e', str(request['minZoom']), '-o', str(stage)]
            if terrain_docker:
                name = 'gis-ctb-' + uuid.uuid4().hex[:12]
                container_args = [engine, 'run', '--rm', '--name', name, '-v', str(work) + ':/data', '--entrypoint', 'ctb-tile', 'ghcr.io/tum-gis/ctb-quantized-mesh:alpine']
                tile_args = ['-f', 'Mesh', '-C', '-N', '-c', str(request['workers']), '-s', str(request['maxZoom']), '-e', str(request['minZoom']), '-o', '/data/result']
                try:
                    run(container_args + tile_args + ['/data/dem.tif'], progress=True)
                    run(container_args + tile_args + ['-l', '/data/dem.tif'])
                finally:
                    subprocess.run([engine, 'rm', '-f', name], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=15)
            else:
                run(args + [str(normalized)], progress=True)
                run(args + ['-l', str(normalized)])
            bounds = inspect_data(str(normalized))['bounds']
            layer = json.loads((stage / 'layer.json').read_text())
            if layer.get('format') != 'quantized-mesh-1.0' or not any(stage.glob('*/*/*.terrain')):
                raise ValueError('地形成果校验失败')
            layer['bounds'] = bounds
            (stage / 'layer.json').write_text(json.dumps(layer, indent=2))
        else:
            emit('stage', message='转换 OSGB 场景')
            args = [engine, '-f', 'osgb', '-i', str(source), '-o', str(stage)]
            if request.get('longitude') is not None:
                args += ['-c', json.dumps({'x': request['longitude'], 'y': request['latitude']})]
            run(args)
            manifest = json.loads((stage / 'tileset.json').read_text())
            if not manifest.get('root') or not manifest.get('asset'):
                raise ValueError('3D Tiles 成果缺少 root 或 asset')
        emit('stage', message='校验并完成输出')
        metadata = {'kind': kind, 'input': str(source), 'parameters': request, 'bounds': bounds,
                    'scheme': 'xyz' if kind == 'imagery' else None}
        (stage / 'gis-manifest.json').write_text(json.dumps(metadata, ensure_ascii=False, indent=2))
        # Recheck to avoid replacing files created by another process during conversion.
        if output.exists():
            if any(output.iterdir()):
                raise ValueError('输出目录在加工期间被写入，已停止提交成果')
            output.rmdir()
        stage.rename(output)
    return {'output': str(output), 'kind': kind}


def main():
    payload = json.load(sys.stdin)
    if payload['action'] == 'inspect':
        result = inspect_data(payload['path'])
    elif payload['action'] == 'process':
        result = process_data(payload['request'], payload['engines'])
    else:
        raise ValueError('未知 worker 操作')
    emit('result', value=result)


if __name__ == '__main__':
    def terminate(signum, frame):
        raise SystemExit(130)
    signal.signal(signal.SIGTERM, terminate)
    try:
        main()
    except Exception as error:
        emit('error', message=str(error))
        traceback.print_exc(file=sys.stderr)
        sys.exit(1)
