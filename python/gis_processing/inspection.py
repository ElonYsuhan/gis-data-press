"""Read raster metadata without processing data."""

import math
from pathlib import Path


def inspect_data(filename):
    source = Path(filename).resolve(strict=True)
    if source.is_dir():
        count = sum(1 for p in source.rglob('*.osgb') if p.is_file() and not p.is_symlink())
        if not count:
            raise ValueError('目录中没有 OSGB 数据')
        return {
            'path': str(source),
            'type': 'OSGB',
            'files': count,
            'warnings': []
            if (source / 'metadata.xml').exists()
            else ['没有 metadata.xml，需要填写 WGS84 定位经纬度'],
        }
    if source.suffix.lower() not in ('.tif', '.tiff', '.vrt'):
        return {
            'path': str(source),
            'type': source.suffix.upper().lstrip('.'),
            'size': source.stat().st_size,
            'warnings': ['此文件可作为静态资源发布；加工模块支持 TIFF、VRT 和 OSGB 目录'],
        }
    import rasterio
    from rasterio.warp import transform_bounds

    with rasterio.open(source) as ds:
        warnings = []
        if not ds.crs:
            warnings.append('缺少坐标系，需要在任务中填写源 CRS')
        if ds.count == 1:
            warnings.append('高程基准无法仅凭 TIFF 自动确认；地形加工前请确认米制椭球高')
        bounds = (
            list(transform_bounds(ds.crs, 'EPSG:4326', *ds.bounds)) if ds.crs else list(ds.bounds)
        )
        projected = transform_bounds(ds.crs, 'EPSG:3857', *ds.bounds) if ds.crs else None
        resolution = (
            max((projected[2] - projected[0]) / ds.width, (projected[3] - projected[1]) / ds.height)
            if projected
            else None
        )
        latitude = (bounds[1] + bounds[3]) / 2
        metres = resolution * math.cos(math.radians(latitude)) if resolution else None
        recommended = (
            {
                'imagery': max(
                    0, min(22, math.ceil(math.log2(156543.033928 / resolution) - 1e-10))
                ),
                'terrain': max(0, min(22, math.ceil(math.log2(313086.067856 / metres) - 1e-10))),
            }
            if resolution
            and metres
            and resolution > 0
            and metres > 0
            and math.isfinite(resolution)
            and math.isfinite(metres)
            else None
        )
        return {
            'path': str(source),
            'type': 'GeoTIFF' if source.suffix.lower() != '.vrt' else 'VRT',
            'size': source.stat().st_size,
            'width': ds.width,
            'height': ds.height,
            'bands': ds.count,
            'crs': ds.crs.to_string() if ds.crs else '',
            'bounds': bounds,
            'nodata': ds.nodata
            if ds.nodata is None or (ds.nodata == ds.nodata and abs(ds.nodata) != float('inf'))
            else None,
            'dtype': ds.dtypes[0],
            'units': ds.units[0] or '',
            'warnings': warnings,
            'pixelSize': list(ds.res),
            'resolutionMeters': metres if metres and math.isfinite(metres) and metres > 0 else None,
            'centerLatitude': latitude if ds.crs else None,
            'recommendedZoom': recommended,
        }
