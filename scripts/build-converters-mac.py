"""Build pinned upstream CTB/OSGB converters on Apple Silicon (development machine only).
Requires CMake, Rust, GDAL and OpenSceneGraph development headers. End users need none.
"""

import argparse
import shutil
import subprocess
from pathlib import Path


def run(*args, **kwargs):
    subprocess.run(args, check=True, **kwargs)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--work', default='.test-artifacts/native-build')
    args = parser.parse_args()
    work = Path(args.work).resolve()
    work.mkdir(parents=True, exist_ok=True)
    sources = {}
    for name, url, commit in [
        (
            'ctb',
            'https://github.com/ahuarte47/cesium-terrain-builder.git',
            '776b60308c89383462a91d152a190fcd667b74f7',
        ),
        (
            'osgb',
            'https://github.com/fanvanzh/3dtiles.git',
            'd540b5d136721fdf6df3c4437b5b7cadccdfd5d4',
        ),
    ]:
        source = work / (name + '-source')
        if not source.exists():
            run('git', 'init', str(source))
            run('git', '-C', str(source), 'remote', 'add', 'origin', url)
        run('git', '-C', str(source), 'fetch', '--depth', '1', 'origin', commit)
        run('git', '-C', str(source), 'checkout', '--force', 'FETCH_HEAD')
        sources[name] = source
    ctb = sources['ctb']
    run(
        'cmake',
        '-S',
        str(ctb),
        '-B',
        str(work / 'ctb-build'),
        '-U',
        'HAVE_UNIFIED_GDAL',
        '-DCMAKE_POLICY_VERSION_MINIMUM=3.5',
        '-DCMAKE_BUILD_TYPE=Release',
        '-DCMAKE_INSTALL_PREFIX=' + str(work / 'ctb-install'),
        '-DGDAL_LIBRARY_DIR=/opt/homebrew/opt/gdal/lib',
    )
    run('cmake', '--build', str(work / 'ctb-build'), '-j4')
    run('cmake', '--install', str(work / 'ctb-build'))
    osgb = sources['osgb']
    for file in (osgb / 'src').glob('*.cpp'):
        text = (
            file.read_text()
            .replace('"gdal/ogrsf_frmts.h"', '<ogrsf_frmts.h>')
            .replace('<gdal/ogrsf_frmts.h>', '<ogrsf_frmts.h>')
            .replace('<gdal/ogr_spatialref.h>', '<ogr_spatialref.h>')
        )
        file.write_text(text)
    # Enable real coordinate conversion on macOS; upstream v0.4 had Unix stubs.
    file = osgb / 'src/tileset.cpp'
    text = file.read_text()
    start = text.index('#ifdef _WIN32')
    end = text.index('\n#endif', start) + len('\n#endif')
    block = (
        text[start : text.index('\n#else', start)]
        .replace('#ifdef _WIN32\n', '')
        .replace(
            'CPLSetConfigOption("GDAL_DATA", path);',
            'if (!CPLGetConfigOption("GDAL_DATA", nullptr)) CPLSetConfigOption("GDAL_DATA", path);',
        )
        .replace(
            'outRs.importFromEPSG(4326);',
            'outRs.importFromEPSG(4326);\n inRs.SetAxisMappingStrategy(OAMS_TRADITIONAL_GIS_ORDER);\n outRs.SetAxisMappingStrategy(OAMS_TRADITIONAL_GIS_ORDER);',
        )
    )
    file.write_text(text[:start] + block + text[end:])
    file = osgb / 'Cargo.toml'
    file.write_text(file.read_text().replace('serde-xml-rs = "0.2.1"', 'serde-xml-rs = "0.6"'))
    file = osgb / 'src/main.rs'
    file.write_text(
        file.read_text()
        .replace(
            'serde_xml_rs::deserialize::<_, ModelMetadata>',
            'serde_xml_rs::from_reader::<_, ModelMetadata>',
        )
        .replace('.join("gdal_data")', '.join("share").join("gdal")')
    )
    (osgb / 'build.rs').write_text("""extern crate cc;
fn main() {
 cc::Build::new().cpp(true).flag("-std=c++11").warnings(false)
 .include("/opt/homebrew/include").include("/opt/homebrew/opt/gdal/include").include("./src")
 .file("./src/tileset.cpp").file("./src/shp23dtile.cpp").file("./src/osgb23dtile.cpp").file("./src/dxt_img.cpp").compile("_3dtile");
 println!("cargo:rustc-link-search=native=/opt/homebrew/lib");
 for lib in ["gdal", "OpenThreads", "osg", "osgDB", "osgUtil", "c++"] { println!("cargo:rustc-link-lib={}", lib); }
}
""")
    run('cargo', 'build', '--release', '--manifest-path', str(osgb / 'Cargo.toml'))
    run(
        '/usr/bin/python3',
        'scripts/bundle-native-mac.py',
        '--ctb',
        str(work / 'ctb-install/bin/ctb-tile'),
        '--osgb',
        str(osgb / 'target/release/_3dtile'),
    )
    target = Path('resources/engines/licenses')
    target.mkdir(parents=True, exist_ok=True)
    shutil.copy2(ctb / 'LICENSE.md', target / 'CTB-LICENSE.txt')
    shutil.copy2(osgb / 'LICENSE', target / '3DTILES-LICENSE.txt')


if __name__ == '__main__':
    main()
