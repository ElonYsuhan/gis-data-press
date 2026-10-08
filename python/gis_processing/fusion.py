"""Build a bounded-memory, common-grid mosaic and retain it as a COG master."""

import json
import math
from contextlib import ExitStack
from pathlib import Path
from xml.sax.saxutils import escape

import numpy as np
import rasterio
from rasterio.enums import ColorInterp, Resampling
from rasterio.shutil import copy as copy_raster
from rasterio.transform import from_origin
from rasterio.vrt import WarpedVRT
from rasterio.warp import calculate_default_transform, transform_bounds

from . import runtime
from .imagery import imagery_input


def input_paths(request):
    values = request.get('inputs') or [request['input']]
    return list(
        dict.fromkeys(str(Path(value).expanduser().resolve(strict=True)) for value in values)
    )


def build_master(sources, directory, request):
    """Later valid samples win. Precision policy sorts coarse sources before fine ones."""
    kind = request['kind']
    target = 'EPSG:4326' if kind == 'terrain' else 'EPSG:3857'
    entries = []
    for index, filename in enumerate(sources):
        source = Path(filename)
        with rasterio.open(source) as ds:
            crs = ds.crs or request.get('sourceCrs')
            if not crs:
                raise ValueError(f'{source.name} 缺少坐标系，请设置源 CRS')
            if kind == 'terrain':
                if ds.count != 1:
                    raise ValueError(f'{source.name} 必须是单波段高程')
                if (ds.units[0] or '').lower() not in (
                    '',
                    'm',
                    'meter',
                    'metre',
                    'meters',
                    'metres',
                ):
                    raise ValueError(f'{source.name} 高程单位不是米')
            transform, _, _ = calculate_default_transform(
                crs, target, ds.width, ds.height, *ds.bounds
            )
            bounds = transform_bounds(crs, target, *ds.bounds, densify_pts=21)
            if not all(math.isfinite(value) for value in bounds):
                raise ValueError(f'{source.name} 投影范围无效')
            entries.append(
                {'path': filename, 'bounds': bounds, 'resolution': abs(transform.a), 'index': index}
            )
        if kind == 'imagery':
            prepared, _ = imagery_input(source, directory / f'prepared-{index}.tif', request)
            entries[-1]['prepared'] = str(prepared)
    if request.get('fusionPolicy', 'precision') == 'precision':
        entries.sort(key=lambda entry: entry['resolution'], reverse=True)
    resolution = min(entry['resolution'] for entry in entries)
    left = min(entry['bounds'][0] for entry in entries)
    bottom = min(entry['bounds'][1] for entry in entries)
    right = max(entry['bounds'][2] for entry in entries)
    top = max(entry['bounds'][3] for entry in entries)
    if kind == 'imagery':
        limit = 20037508.342789244
        left, bottom, right, top = (
            max(-limit, left),
            max(-limit, bottom),
            min(limit, right),
            min(limit, top),
        )
    left, top = math.floor(left / resolution) * resolution, math.ceil(top / resolution) * resolution
    width = math.ceil((right - left) / resolution)
    height = math.ceil((top - bottom) / resolution)
    if width <= 0 or height <= 0:
        raise ValueError('输入数据没有可用覆盖范围')
    grid = from_origin(left, top, resolution, resolution)
    temporary = directory / 'mosaic.partial.tif'
    master = directory / 'master.tif'
    profile = dict(
        driver='GTiff',
        width=width,
        height=height,
        count=1 if kind == 'terrain' else 4,
        dtype='float32' if kind == 'terrain' else 'uint8',
        crs=target,
        transform=grid,
        nodata=float('nan') if kind == 'terrain' else None,
        tiled=True,
        blockxsize=256,
        blockysize=256,
        compress='deflate',
        BIGTIFF='IF_SAFER',
    )
    offsets = request.get('heightOffsets') or {}
    runtime.emit(
        'log',
        message=f'融合网格 {width} × {height}，{len(entries)} 个输入；逐块读取，无效值不覆盖有效值',
    )
    with ExitStack() as stack:
        readers = []
        for entry in entries:
            ds = stack.enter_context(rasterio.open(entry.get('prepared', entry['path'])))
            vrt = stack.enter_context(
                WarpedVRT(
                    ds,
                    src_crs=ds.crs or request.get('sourceCrs'),
                    crs=target,
                    transform=grid,
                    width=width,
                    height=height,
                    resampling=Resampling.bilinear,
                    dtype='float32' if kind == 'terrain' else 'uint8',
                    nodata=float('nan') if kind == 'terrain' else None,
                    add_alpha=kind == 'imagery' and ds.count == 3,
                    warp_mem_limit=128,
                )
            )
            readers.append((entry, vrt))
        out = stack.enter_context(rasterio.open(temporary, 'w', **profile))
        if kind == 'terrain':
            out.set_band_unit(1, 'm')
        if kind == 'imagery':
            out.colorinterp = (
                ColorInterp.red,
                ColorInterp.green,
                ColorInterp.blue,
                ColorInterp.alpha,
            )
        total = math.ceil(width / 256) * math.ceil(height / 256)
        for completed, (_, window) in enumerate(out.block_windows(1), 1):
            shape = (int(window.height), int(window.width))
            merged = (
                np.full((1, *shape), np.nan, dtype='float32')
                if kind == 'terrain'
                else np.zeros((4, *shape), dtype='uint8')
            )
            for entry, vrt in readers:
                wb = rasterio.windows.bounds(window, grid)
                sb = entry['bounds']
                if wb[0] >= sb[2] or wb[2] <= sb[0] or wb[1] >= sb[3] or wb[3] <= sb[1]:
                    continue
                data = vrt.read(window=window, masked=True)
                if kind == 'terrain':
                    valid = ~np.ma.getmaskarray(data)[0] & np.isfinite(data.data[0])
                    values = data.data[0] + float(offsets.get(entry['path'], 0))
                    merged[0, valid] = values[valid]
                else:
                    valid = (vrt.dataset_mask(window=window) > 0) & (data.data[3] > 0)
                    # Source-over compositing keeps coarse valid coverage under partially
                    # transparent boundary samples instead of punching holes in the mosaic.
                    source_alpha = data.data[3, valid].astype('float32') / 255
                    destination_alpha = merged[3, valid].astype('float32') / 255
                    alpha = source_alpha + destination_alpha * (1 - source_alpha)
                    rgb = (
                        data.data[:3, valid].astype('float32') * source_alpha
                        + merged[:3, valid].astype('float32')
                        * destination_alpha
                        * (1 - source_alpha)
                    ) / alpha
                    merged[:3, valid] = np.rint(rgb).astype('uint8')
                    merged[3, valid] = np.rint(alpha * 255).astype('uint8')
            out.write(merged, window=window)
            if completed % 32 == 0 or completed == total:
                runtime.emit(
                    'progress',
                    percent=100 * completed / total,
                    label=f'融合数据块 {completed}/{total}',
                )
    runtime.emit('stage', message='保存 COG 加工母数据')
    copy_raster(
        temporary,
        master,
        driver='COG',
        compress='DEFLATE',
        blocksize=256,
        overview_resampling='AVERAGE',
        BIGTIFF='IF_SAFER',
    )
    temporary.unlink()
    for entry in entries:
        prepared = entry.get('prepared')
        if prepared and prepared != entry['path']:
            Path(prepared).unlink(missing_ok=True)
    with rasterio.open(master) as ds:
        bounds = list(transform_bounds(ds.crs, 'EPSG:4326', *ds.bounds))
        bands = []
        for band in range(1, ds.count + 1):
            attributes = (
                '<NoDataValue>nan</NoDataValue><UnitType>m</UnitType>'
                if kind == 'terrain'
                else '<ColorInterp>'
                + ['Red', 'Green', 'Blue', 'Alpha'][band - 1]
                + '</ColorInterp>'
            )
            bands.append(
                f'<VRTRasterBand dataType="{"Float32" if kind == "terrain" else "Byte"}" band="{band}">{attributes}<SimpleSource><SourceFilename relativeToVRT="1">master.tif</SourceFilename><SourceBand>{band}</SourceBand><SrcRect xOff="0" yOff="0" xSize="{ds.width}" ySize="{ds.height}"/><DstRect xOff="0" yOff="0" xSize="{ds.width}" ySize="{ds.height}"/></SimpleSource></VRTRasterBand>'
            )
        (directory / 'master.vrt').write_text(
            f'<VRTDataset rasterXSize="{ds.width}" rasterYSize="{ds.height}"><SRS>{escape(ds.crs.to_wkt())}</SRS><GeoTransform>{",".join(map(str, ds.transform.to_gdal()))}</GeoTransform>{"".join(bands)}</VRTDataset>'
        )
    (directory / 'sources.json').write_text(
        json.dumps(
            {
                'sources': entries,
                'policy': request.get('fusionPolicy', 'precision'),
                'heightOffsets': offsets,
                'verticalDatum': request.get('verticalDatum'),
                'bounds': bounds,
            },
            ensure_ascii=False,
            indent=2,
        )
    )
    return master, bounds
