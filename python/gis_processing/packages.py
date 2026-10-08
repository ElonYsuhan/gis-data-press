"""SQLite tile containers: MBTiles imagery and GeoPress Quantized Mesh v1."""

import json
import math
import sqlite3
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import rasterio
from rasterio.enums import Resampling
from rasterio.io import MemoryFile
from rasterio.transform import from_origin
from rasterio.vrt import WarpedVRT

from . import runtime

WORLD = 20037508.342789244


def connect_package(filename, kind):
    db = sqlite3.connect(filename)
    db.execute('PRAGMA journal_mode=DELETE')
    db.execute('PRAGMA synchronous=FULL')
    db.executescript("""
        CREATE TABLE IF NOT EXISTS metadata (name TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS tiles (
            zoom_level INTEGER NOT NULL, tile_column INTEGER NOT NULL,
            tile_row INTEGER NOT NULL, tile_data BLOB NOT NULL,
            PRIMARY KEY (zoom_level, tile_column, tile_row)
        ) WITHOUT ROWID;
        CREATE TABLE IF NOT EXISTS completed (
            zoom_level INTEGER, tile_column INTEGER, tile_row INTEGER,
            PRIMARY KEY (zoom_level, tile_column, tile_row)
        ) WITHOUT ROWID;
    """)
    db.execute(
        'INSERT OR REPLACE INTO metadata VALUES (?,?)',
        ('format', 'png' if kind == 'imagery' else 'quantized-mesh-1.0'),
    )
    return db


def metadata(db, values):
    db.executemany(
        'INSERT OR REPLACE INTO metadata VALUES (?,?)',
        [(name, str(value)) for name, value in values.items()],
    )
    db.commit()


def png_bytes(data):
    with MemoryFile() as memory:
        with memory.open(
            driver='PNG', width=256, height=256, count=4, dtype='uint8', ZLEVEL=1
        ) as ds:
            ds.write(data)
        return memory.read()


def tile_range(bounds, zoom):
    left, bottom, right, top = bounds
    size = 2**zoom
    step = 2 * WORLD / size
    return (
        max(0, min(size - 1, math.floor((left + WORLD) / step))),
        max(0, min(size - 1, math.floor((WORLD - top) / step))),
        max(0, min(size - 1, math.ceil((right + WORLD) / step) - 1)),
        max(0, min(size - 1, math.ceil((WORLD - bottom) / step) - 1)),
    )


def write_imagery(master, filename, request, bounds, manifest):
    """Bounded tile batches, parallel rendering, one SQLite writer. Resume committed tiles."""
    db = connect_package(filename, 'imagery')
    try:
        with rasterio.open(master) as source:
            ranges = {
                z: tile_range(source.bounds, z)
                for z in range(request['minZoom'], request['maxZoom'] + 1)
            }
        total = sum((r[2] - r[0] + 1) * (r[3] - r[1] + 1) for r in ranges.values())
        metadata(
            db,
            {
                'name': Path(request['output']).stem,
                'type': 'baselayer',
                'version': '1.3',
                'description': 'GeoPress fused imagery',
                'bounds': ','.join(map(str, bounds)),
                'minzoom': request['minZoom'],
                'maxzoom': request['maxZoom'],
                'scheme': 'tms',
                'geopress:manifest': json.dumps(manifest, ensure_ascii=False),
                'geopress:complete': '0',
            },
        )

        def render(key):
            z, x, y = key
            resolution = 2 * WORLD / (256 * 2**z)
            transform = from_origin(
                -WORLD + x * 256 * resolution, WORLD - y * 256 * resolution, resolution, resolution
            )
            with (
                rasterio.open(master) as source,
                WarpedVRT(
                    source,
                    crs='EPSG:3857',
                    transform=transform,
                    width=256,
                    height=256,
                    resampling=Resampling.average,
                    warp_mem_limit=32,
                ) as vrt,
            ):
                pixels = vrt.read()
                return key, png_bytes(pixels)

        completed = 0
        with ThreadPoolExecutor(max_workers=request['workers']) as pool:
            for z, (x0, y0, x1, y1) in ranges.items():
                # Only one tile row's completion keys are held at once.
                for y in range(y0, y1 + 1):
                    stored_y = 2**z - 1 - y
                    done = {
                        row[0]
                        for row in db.execute(
                            'SELECT tile_column FROM completed WHERE zoom_level=? AND tile_row=?',
                            (z, stored_y),
                        )
                    }
                    pending = []
                    for x in range(x0, x1 + 1):
                        if x in done:
                            completed += 1
                        else:
                            pending.append((z, x, y))
                        if len(pending) == 64 or x == x1:
                            for (level, column, row), payload in pool.map(render, pending):
                                tms_row = 2**level - 1 - row
                                if payload is not None:
                                    db.execute(
                                        'INSERT OR REPLACE INTO tiles VALUES (?,?,?,?)',
                                        (level, column, tms_row, payload),
                                    )
                                db.execute(
                                    'INSERT OR IGNORE INTO completed VALUES (?,?,?)',
                                    (level, column, tms_row),
                                )
                                completed += 1
                            db.commit()
                            pending.clear()
                            runtime.emit(
                                'progress',
                                percent=100 * completed / total,
                                label=f'切片并写入 MBTiles {completed}/{total}',
                            )
        if db.execute('SELECT COUNT(*) FROM tiles').fetchone()[0] == 0:
            raise ValueError('输入没有生成有效影像瓦片')
        metadata(db, {'geopress:complete': '1'})
        validate_package(db)
    finally:
        db.close()


def write_terrain(stage, filename, manifest):
    layer = json.loads((stage / 'layer.json').read_text())
    if layer.get('format') != 'quantized-mesh-1.0':
        raise ValueError('地形格式不是 Quantized Mesh')
    layer['tiles'] = ['{z}/{x}/{y}.terrain']
    db = connect_package(filename, 'terrain')
    try:
        metadata(
            db,
            {
                'name': Path(manifest['parameters']['output']).stem,
                'scheme': layer.get('scheme', 'tms'),
                'geopress:container': 'quantized-mesh-sqlite-v1',
                'geopress:manifest': json.dumps(manifest, ensure_ascii=False),
                'layer.json': json.dumps(layer),
                'geopress:complete': '0',
            },
        )
        # Keep CTB's geographic/TMS coordinates exactly; imagery's XYZ conversion does not apply.
        completed = 0
        for zoom_dir in stage.iterdir():
            if not zoom_dir.is_dir() or not zoom_dir.name.isdigit():
                continue
            for column_dir in zoom_dir.iterdir():
                if not column_dir.is_dir() or not column_dir.name.isdigit():
                    continue
                for tile in column_dir.glob('*.terrain'):
                    if not tile.stem.isdigit():
                        continue
                    key = (int(zoom_dir.name), int(column_dir.name), int(tile.stem))
                    existing = db.execute(
                        'SELECT 1 FROM tiles WHERE zoom_level=? AND tile_column=? AND tile_row=?',
                        key,
                    ).fetchone()
                    if not existing:
                        payload = tile.read_bytes()
                        if not payload:
                            raise ValueError(f'空地形瓦片：{tile}')
                        db.execute('INSERT INTO tiles VALUES (?,?,?,?)', (*key, payload))
                    completed += 1
                    if completed % 128 == 0:
                        db.commit()
                        runtime.emit('progress', percent=0, label=f'已打包 {completed} 个地形瓦片')
        if completed == 0:
            raise ValueError('没有可打包的地形瓦片')
        metadata(
            db,
            {
                'minzoom': db.execute('SELECT MIN(zoom_level) FROM tiles').fetchone()[0],
                'maxzoom': db.execute('SELECT MAX(zoom_level) FROM tiles').fetchone()[0],
                'bounds': ','.join(map(str, manifest['bounds'])),
                'geopress:complete': '1',
            },
        )
        validate_package(db)
    finally:
        db.close()


def validate_package(db):
    if db.execute('PRAGMA quick_check').fetchone()[0] != 'ok':
        raise ValueError('SQLite 完整性校验失败')
    if db.execute('SELECT COUNT(*) FROM tiles WHERE length(tile_data)=0').fetchone()[0]:
        raise ValueError('成果包包含空瓦片')
