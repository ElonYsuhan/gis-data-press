import importlib.util
from pathlib import Path
import tempfile
import unittest
import numpy as np
import rasterio
from rasterio.transform import from_origin
spec = importlib.util.spec_from_file_location('worker', Path(__file__).parents[1] / 'python' / 'worker.py')
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)

class WorkerTests(unittest.TestCase):
    def test_inspect_and_windowed_conversion_preserve_spatial_extent_and_nodata(self):
        with tempfile.TemporaryDirectory() as folder:
            source = Path(folder) / 'dem.tif'; output = Path(folder) / 'rgba.tif'
            data = np.arange(256 * 256, dtype='uint16').reshape(256, 256)
            with rasterio.open(source, 'w', driver='GTiff', width=256, height=256, count=1,
                               dtype='uint16', crs='EPSG:4326', transform=from_origin(110, 31, .001, .001), nodata=0) as ds:
                ds.write(data, 1)
            inspected = worker.inspect_data(str(source))
            self.assertEqual(inspected['width'], 256)
            self.assertEqual(inspected['crs'], 'EPSG:4326')
            bounds = worker.prepare_imagery(source, output, {'scale': True})
            with rasterio.open(output) as ds:
                self.assertEqual(ds.count, 4)
                self.assertEqual(ds.dtypes[0], 'uint8')
                self.assertEqual(ds.read(4)[0, 0], 0)
                self.assertEqual(ds.read(4)[1, 1], 255)
                self.assertEqual(list(ds.bounds), bounds)
                np.testing.assert_array_equal(ds.read(1), ds.read(2))

    def test_byte_rgba_fast_path_preserves_pixels_and_skips_temporary_copy(self):
        with tempfile.TemporaryDirectory() as folder:
            source = Path(folder) / 'rgba.tif'; temporary = Path(folder) / 'unnecessary.tif'
            data = np.full((4, 32, 32), 100, dtype='uint8'); data[3] = 255; data[3, 0, 0] = 0
            with rasterio.open(source, 'w', driver='GTiff', width=32, height=32, count=4,
                               dtype='uint8', crs='EPSG:3857', transform=from_origin(11000000, 4000000, 5, 5)) as ds:
                ds.write(data)
                ds.colorinterp = (rasterio.enums.ColorInterp.red, rasterio.enums.ColorInterp.green, rasterio.enums.ColorInterp.blue, rasterio.enums.ColorInterp.alpha)
            selected, _ = worker.imagery_input(source, temporary, {'scale': False, 'sourceCrs': ''})
            self.assertEqual(selected, source); self.assertFalse(temporary.exists())
            with rasterio.open(selected) as ds: np.testing.assert_array_equal(ds.read(), data)
            self.assertEqual(worker.inspect_data(str(source))['recommendedZoom']['imagery'], 15)

    def test_engine_progress_stream_is_read_before_newline(self):
        from unittest.mock import patch
        import sys
        events = []
        with patch.object(worker, 'emit', side_effect=lambda event, **kwargs: events.append((event, kwargs))):
            worker.run([sys.executable, '-c', "import sys,time;sys.stdout.write('0...10...');sys.stdout.flush();time.sleep(.1);sys.stdout.write('50...100 - done.\\n');sys.stdout.flush()"], progress=True)
        self.assertEqual([v['percent'] for k, v in events if k == 'progress'], [0, 10, 50, 100])

    def test_native_gdal_tiles_have_alpha_and_real_progress(self):
        import shutil
        from unittest.mock import patch
        engine = shutil.which('gdal2tiles')
        if not engine or not Path(engine).with_name('gdal').exists(): self.skipTest('原生 GDAL 不可用')
        with tempfile.TemporaryDirectory() as folder:
            source = Path(folder) / 'source.tif'; output = Path(folder) / 'result'
            data = np.full((4, 512, 512), 100, dtype='uint8'); data[3] = 255; data[3, :256, :256] = 0
            with rasterio.open(source, 'w', driver='GTiff', width=512, height=512, count=4, dtype='uint8', crs='EPSG:3857', transform=from_origin(12000000, 4200000, 5, 5)) as ds:
                ds.write(data);ds.colorinterp=(rasterio.enums.ColorInterp.red,rasterio.enums.ColorInterp.green,rasterio.enums.ColorInterp.blue,rasterio.enums.ColorInterp.alpha)
            events=[]
            with patch.object(worker, 'emit', side_effect=lambda event, **kwargs: events.append((event, kwargs))):
                result=worker.process_data({'kind':'imagery','input':str(source),'output':str(output),'workers':2,'minZoom':0,'maxZoom':15,'scale':False,'sourceCrs':''}, {'gdal':engine})
            tiles=list(output.glob('15/*/*.png'));self.assertTrue(tiles)
            opaque=False;transparent=False
            for tile in tiles:
                with rasterio.open(tile) as ds:
                    self.assertEqual(ds.width,256);self.assertEqual(ds.count,4)
                    alpha=ds.read(4);opaque|=bool(np.any(alpha==255));transparent|=bool(np.any(alpha==0))
            self.assertTrue(opaque);self.assertTrue(transparent)
            self.assertTrue(any(k=='progress' and v['percent']==100 for k,v in events))
            self.assertTrue(any(k=='log' and '跳过整份' in v['message'] for k,v in events))
            self.assertTrue(any(k=='log' and '原生切片' in v['message'] for k,v in events))

    def test_existing_output_is_never_overwritten(self):
        with tempfile.TemporaryDirectory() as folder:
            source = Path(folder) / 'source.tif'; source.write_bytes(b'input')
            output = Path(folder) / 'output'; output.mkdir(); sentinel = output / 'keep.txt'; sentinel.write_text('keep')
            with self.assertRaisesRegex(ValueError, '必须为空'):
                worker.process_data({'kind': 'imagery', 'input': str(source), 'output': str(output)}, {})
            self.assertEqual(sentinel.read_text(), 'keep')

    def test_missing_engine_does_not_create_output(self):
        with tempfile.TemporaryDirectory() as folder:
            source = Path(folder) / 'source.tif'; source.write_bytes(b'input'); output = Path(folder) / 'output'
            with self.assertRaisesRegex(ValueError, '缺少'):
                worker.process_data({'kind': 'imagery', 'input': str(source), 'output': str(output)}, {})
            self.assertFalse(output.exists())

if __name__ == '__main__': unittest.main()
