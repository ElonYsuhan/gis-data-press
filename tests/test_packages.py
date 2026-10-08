import json
import sqlite3
import sys
import tempfile
import unittest
from contextlib import closing
from pathlib import Path
from unittest.mock import patch

import numpy as np
import rasterio
from rasterio.io import MemoryFile
from rasterio.transform import from_origin

sys.path.insert(0, str(Path(__file__).parents[1] / 'python'))
from gis_processing.fusion import build_master
from gis_processing.package_pipeline import process_package
from gis_processing.packages import write_terrain
from gis_processing.pipeline import process_data


def raster(path, value, pixel=1, nodata=-9999, crs='EPSG:4326', x=110, y=30):
    with rasterio.open(
        path,
        'w',
        driver='GTiff',
        width=8,
        height=8,
        count=1,
        dtype='float32',
        crs=crs,
        transform=from_origin(x, y, pixel, pixel),
        nodata=nodata,
    ) as ds:
        ds.write(np.full((8, 8), value, dtype='float32'), 1)


class FusionPackageTests(unittest.TestCase):
    def test_priority_nodata_and_height_offset_are_applied_on_shared_grid(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            coarse, fine = root / 'coarse.tif', root / 'fine.tif'
            raster(coarse, 100, pixel=0.02)
            raster(fine, 200, pixel=0.01)
            with rasterio.open(fine, 'r+') as ds:
                values = ds.read(1)
                values[:4, :4] = -9999
                ds.write(values, 1)
            work = root / 'work'
            work.mkdir()
            request = {
                'kind': 'terrain',
                'fusionPolicy': 'precision',
                'heightOffsets': {str(fine): 5},
            }
            master, _ = build_master([str(fine), str(coarse)], work, request)
            with rasterio.open(master) as ds:
                self.assertEqual(ds.tags(ns='IMAGE_STRUCTURE')['LAYOUT'], 'COG')
                self.assertAlmostEqual(ds.read(1)[1, 1], 100)
                self.assertAlmostEqual(ds.read(1)[6, 6], 205)
                self.assertAlmostEqual(ds.read(1)[12, 12], 100)
            self.assertTrue((work / 'master.vrt').exists())
            with rasterio.open(work / 'master.vrt') as ds:
                self.assertAlmostEqual(ds.read(1)[6, 6], 205)

    def test_imagery_direct_package_has_tms_rows_and_transparency(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            source = root / 'rgb.tif'
            pixels = np.full((4, 32, 32), 80, dtype='uint8')
            pixels[3] = 255
            pixels[3, :16, :16] = 0
            with rasterio.open(
                source,
                'w',
                driver='GTiff',
                width=32,
                height=32,
                count=4,
                dtype='uint8',
                crs='EPSG:3857',
                transform=from_origin(12000000, 4200000, 2000, 2000),
            ) as ds:
                ds.write(pixels)
                ds.colorinterp = (
                    rasterio.enums.ColorInterp.red,
                    rasterio.enums.ColorInterp.green,
                    rasterio.enums.ColorInterp.blue,
                    rasterio.enums.ColorInterp.alpha,
                )
            output = root / 'imagery.mbtiles'
            request = {
                'kind': 'imagery',
                'input': str(source),
                'inputs': [str(source)],
                'output': str(output),
                'outputFormat': 'package',
                'fusionPolicy': 'precision',
                'workers': 2,
                'minZoom': 0,
                'maxZoom': 8,
                'scale': False,
                'sourceCrs': '',
            }
            process_data(request, {})
            self.assertTrue(output.is_file())
            self.assertFalse(any(root.glob('imagery.mbtiles.sources/[0-9]*')))
            with closing(sqlite3.connect(output)) as db:
                meta = dict(db.execute('SELECT name,value FROM metadata'))
                self.assertEqual(meta['scheme'], 'tms')
                self.assertEqual(meta['geopress:complete'], '1')
                rows = db.execute(
                    'SELECT tile_row,tile_data FROM tiles WHERE zoom_level=8'
                ).fetchall()
                self.assertTrue(rows)
                self.assertTrue(all(row > 128 for row, _ in rows))
                with MemoryFile(rows[0][1]) as memory, memory.open() as ds:
                    self.assertEqual(ds.count, 4)
                    self.assertTrue(np.any(ds.read(4) < 255))
            with self.assertRaisesRegex(ValueError, '已经存在'):
                process_data(request, {})

    def test_resume_reuses_master_and_rejects_changed_inputs(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            source = root / 'dem.tif'
            raster(source, 100, pixel=0.01)
            output = root / 'dem.terrain.sqlite'
            request = {
                'kind': 'terrain',
                'input': str(source),
                'output': str(output),
                'workers': 1,
                'minZoom': 0,
                'maxZoom': 0,
                'verticalDatum': 'ellipsoid',
            }
            calls = []

            def converter(master, stage, req, tools, work):
                calls.append(master)
                if len(calls) == 1:
                    raise RuntimeError('模拟引擎中断')
                (stage / '0/1').mkdir(parents=True)
                (stage / '0/1/0.terrain').write_bytes(bytes(100))
                (stage / 'layer.json').write_text(
                    json.dumps(
                        {
                            'format': 'quantized-mesh-1.0',
                            'scheme': 'tms',
                            'tiles': ['{z}/{x}/{y}.terrain'],
                            'available': [[{'startX': 1, 'startY': 0, 'endX': 1, 'endY': 0}]],
                        }
                    )
                )

            with self.assertRaisesRegex(RuntimeError, '中断'):
                process_package(request, {}, converter)
            with patch(
                'gis_processing.package_pipeline.build_master',
                side_effect=AssertionError('不能重复融合'),
            ):
                process_package(request, {}, converter)
            self.assertTrue(output.is_file())
            with closing(sqlite3.connect(output)) as db:
                self.assertEqual(db.execute('SELECT tile_column FROM tiles').fetchone()[0], 1)
            output.unlink()
            raster(source, 101, pixel=0.01)
            with self.assertRaisesRegex(ValueError, '已经变化'):
                process_package(request, {}, converter)

    def test_partial_alpha_overlays_preserve_valid_background(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            paths = []
            for index, (color, alpha) in enumerate([(80, 255), (180, 128)]):
                path = root / f'{index}.tif'
                paths.append(str(path))
                with rasterio.open(
                    path,
                    'w',
                    driver='GTiff',
                    width=16,
                    height=16,
                    count=4,
                    dtype='uint8',
                    crs='EPSG:3857',
                    transform=from_origin(12000000, 4200000, 1000, 1000),
                ) as ds:
                    data = np.full((4, 16, 16), color, dtype='uint8')
                    data[3] = alpha
                    ds.write(data)
                    ds.colorinterp = (
                        rasterio.enums.ColorInterp.red,
                        rasterio.enums.ColorInterp.green,
                        rasterio.enums.ColorInterp.blue,
                        rasterio.enums.ColorInterp.alpha,
                    )
            work = root / 'master'
            work.mkdir()
            master, _ = build_master(paths, work, {'kind': 'imagery', 'fusionPolicy': 'order'})
            with rasterio.open(master) as ds:
                self.assertEqual(ds.read(1)[8, 8], 130)
                self.assertEqual(ds.read(4)[8, 8], 255)

    def test_imagery_resume_skips_committed_batches(self):
        from gis_processing import runtime
        from gis_processing.packages import png_bytes

        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            source = root / 'source.tif'
            with rasterio.open(
                source,
                'w',
                driver='GTiff',
                width=16,
                height=16,
                count=4,
                dtype='uint8',
                crs='EPSG:3857',
                transform=from_origin(12000000, 4200000, 2000, 2000),
            ) as ds:
                ds.write(np.full((4, 16, 16), 255, dtype='uint8'))
                ds.colorinterp = (
                    rasterio.enums.ColorInterp.red,
                    rasterio.enums.ColorInterp.green,
                    rasterio.enums.ColorInterp.blue,
                    rasterio.enums.ColorInterp.alpha,
                )
            output = root / 'resume.mbtiles'
            request = {
                'kind': 'imagery',
                'input': str(source),
                'output': str(output),
                'outputFormat': 'package',
                'workers': 1,
                'minZoom': 0,
                'maxZoom': 3,
                'scale': False,
            }

            def interrupt(event, **values):
                if event == 'progress' and values.get('label', '').startswith('切片并写入'):
                    raise RuntimeError('模拟写包中断')

            with patch.object(runtime, 'emit', side_effect=interrupt):
                with self.assertRaisesRegex(RuntimeError, '写包中断'):
                    process_data(request, {})
            self.assertFalse(output.exists())
            with closing(sqlite3.connect(str(output) + '.sources/package.partial.sqlite')) as db:
                self.assertEqual(db.execute('SELECT COUNT(*) FROM completed').fetchone()[0], 1)
            with (
                patch(
                    'gis_processing.package_pipeline.build_master',
                    side_effect=AssertionError('不应重复融合'),
                ),
                patch('gis_processing.packages.png_bytes', wraps=png_bytes) as encoder,
            ):
                process_data(request, {})
                self.assertEqual(encoder.call_count, 3)

    def test_terrain_packaging_keeps_gzip_bytes_and_layer_metadata(self):
        import gzip

        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / '0/1').mkdir(parents=True)
            payload = gzip.compress(bytes(100))
            (root / '0/1/0.terrain').write_bytes(payload)
            layer = {
                'format': 'quantized-mesh-1.0',
                'scheme': 'tms',
                'tiles': ['{z}/{x}/{y}.terrain?v=1'],
                'available': [[{'startX': 1, 'startY': 0, 'endX': 1, 'endY': 0}]],
            }
            (root / 'layer.json').write_text(json.dumps(layer))
            output = root / 'pack.sqlite'
            write_terrain(
                root, output, {'parameters': {'output': str(output)}, 'bounds': [110, 29, 111, 30]}
            )
            with closing(sqlite3.connect(output)) as db:
                self.assertEqual(db.execute('SELECT tile_data FROM tiles').fetchone()[0], payload)
                metadata = dict(db.execute('SELECT name,value FROM metadata'))
                self.assertEqual(
                    json.loads(metadata['layer.json'])['available'], layer['available']
                )


if __name__ == '__main__':
    unittest.main()
