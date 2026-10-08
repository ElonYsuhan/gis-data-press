"""Windowed RGB preparation and imagery tile generation."""

import math
import os
import subprocess
import time
from pathlib import Path

from . import runtime


def imagery_input(source, destination, request):
    import rasterio
    from rasterio.enums import ColorInterp
    from rasterio.warp import transform_bounds

    with rasterio.open(source) as ds:
        expected = (ColorInterp.red, ColorInterp.green, ColorInterp.blue)
        if (
            not request.get('scale')
            and not request.get('sourceCrs')
            and ds.crs
            and ds.count in (3, 4)
            and all(t == 'uint8' for t in ds.dtypes)
            and ds.colorinterp[:3] == expected
            and (ds.count == 3 or ds.colorinterp[3] == ColorInterp.alpha)
        ):
            runtime.emit('log', message='直接读取 Byte RGB/RGBA 原图，跳过整份临时影像转写')
            return source, list(transform_bounds(ds.crs, 'EPSG:4326', *ds.bounds))
    return destination, prepare_imagery(source, destination, request)


def tile_imagery(engine, source, stage, request):
    candidate = Path(engine).with_name('gdal.exe' if os.name == 'nt' else 'gdal')
    native = None
    if Path(engine).name.startswith('gdal2tiles') and candidate.is_file():
        try:
            help_result = subprocess.run(
                [str(candidate), 'raster', 'tile', '--help'],
                capture_output=True,
                text=True,
                timeout=10,
            )
            if help_result.returncode == 0 and '--num-threads' in help_result.stdout:
                native = (str(candidate), help_result.stdout)
        except (OSError, subprocess.TimeoutExpired):
            pass
    if native:
        command, help_text = native
        args = [
            command,
            'raster',
            'tile',
            '--min-zoom',
            str(request['minZoom']),
            '--max-zoom',
            str(request['maxZoom']),
            '--convention',
            'xyz',
            '--num-threads',
            str(request['workers']),
            '--resampling',
            'average',
            '--webviewer',
            'none',
            '--co',
            'ZLEVEL=1',
        ]
        if '--parallel-method' in help_text:
            args += ['--parallel-method', 'spawn']
        runtime.emit(
            'log',
            message=f'使用 GDAL 原生切片，{request["workers"]} 个并行工作进程，PNG 快速无损压缩',
        )
        runtime.run(args + [str(source), str(stage)], progress=True)
    else:
        runtime.run(
            [
                engine,
                '--xyz',
                '-p',
                'mercator',
                '-z',
                f'{request["minZoom"]}-{request["maxZoom"]}',
                '--processes',
                str(request['workers']),
                '-w',
                'none',
                str(source),
                str(stage),
            ],
            progress=True,
        )


def prepare_imagery(source, destination, request):
    import numpy as np
    import rasterio
    from rasterio.enums import ColorInterp, Resampling
    from rasterio.warp import transform_bounds

    with rasterio.open(source) as ds:
        crs = ds.crs or request.get('sourceCrs')
        if not crs:
            raise ValueError('输入没有坐标系，请填写源 CRS')
        if ds.count not in (1, 3, 4):
            raise ValueError(
                '第一版支持单波段或 RGB/RGBA 影像，请先选择波段生成 1、3 或 4 波段文件'
            )
        indices = [1, 1, 1] if ds.count == 1 else [1, 2, 3]
        if ds.colorinterp[0] == ColorInterp.palette:
            raise ValueError('第一版不转换调色板 TIFF，请先转换为 RGB 影像')
        limits = []
        if ds.dtypes[0] != 'uint8' and not request.get('scale'):
            raise ValueError('非 Byte 影像需要启用百分位拉伸')
        for index in indices:
            if not request.get('scale'):
                limits.append((0, 255))
                continue
            sample = ds.read(
                index,
                out_shape=(min(ds.height, 512), min(ds.width, 512)),
                masked=True,
                resampling=Resampling.nearest,
            ).compressed()
            lo, hi = np.percentile(sample, [2, 98]) if sample.size else (0, 1)
            limits.append((float(lo), float(hi) if hi > lo else float(lo) + 1))
        profile = ds.profile.copy()
        profile.update(
            driver='GTiff',
            dtype='uint8',
            count=4,
            crs=crs,
            nodata=None,
            tiled=True,
            blockxsize=256,
            blockysize=256,
            compress='deflate',
            zlevel=1,
            BIGTIFF='IF_SAFER',
        )
        # Remove incompatible source creation options (e.g. YCbCr / palette metadata).
        for key in ('photometric', 'interleave'):
            profile.pop(key, None)
        with rasterio.open(destination, 'w', **profile) as out:
            out.colorinterp = (
                ColorInterp.red,
                ColorInterp.green,
                ColorInterp.blue,
                ColorInterp.alpha,
            )
            total = math.ceil(ds.width / 256) * math.ceil(ds.height / 256)
            last_update = 0
            for completed, (_, window) in enumerate(out.block_windows(1), 1):
                for target, (index, limits_) in enumerate(zip(indices, limits), 1):
                    data = ds.read(index, window=window)
                    if request.get('scale'):
                        data = data.astype('float32')
                    if request.get('scale'):
                        lo, hi = limits_
                        data = (data - lo) * (255 / (hi - lo))
                    out.write(
                        np.nan_to_num(np.clip(data, 0, 255)).astype('uint8'), target, window=window
                    )
                out.write(ds.dataset_mask(window=window), 4, window=window)
                now = time.monotonic()
                if now - last_update >= 0.3 or completed == total:
                    runtime.emit(
                        'progress',
                        percent=100 * completed / total,
                        label=f'预处理数据块 {completed}/{total}',
                    )
                    last_update = now
        return list(transform_bounds(crs, 'EPSG:4326', *ds.bounds))
