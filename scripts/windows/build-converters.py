"""Native Windows x64 converter build; run in an MSVC x64 developer shell."""

import argparse
import os
import shutil
import subprocess
from pathlib import Path

CTB_COMMIT = '776b60308c89383462a91d152a190fcd667b74f7'
OSGB_COMMIT = 'd540b5d136721fdf6df3c4437b5b7cadccdfd5d4'


def run(*args, **kwargs):
    subprocess.run([str(x) for x in args], check=True, **kwargs)


def checkout(work, name, url, commit):
    source = work / name
    if not source.exists():
        run('git', 'init', source)
        run('git', '-C', source, 'remote', 'add', 'origin', url)
    run('git', '-C', source, 'fetch', '--depth', '1', 'origin', commit)
    run('git', '-C', source, 'checkout', '--force', 'FETCH_HEAD')
    return source


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--vcpkg', required=True)
    parser.add_argument('--work', default='.test-artifacts/windows-native')
    args = parser.parse_args()
    work = Path(args.work).resolve()
    work.mkdir(parents=True, exist_ok=True)
    vcpkg = Path(args.vcpkg).resolve()
    installed = vcpkg / 'installed/x64-windows'
    output = Path('resources/engines').resolve()
    output.mkdir(parents=True, exist_ok=True)
    ctb = checkout(
        work, 'ctb', 'https://github.com/ahuarte47/cesium-terrain-builder.git', CTB_COMMIT
    )
    # Static CTB avoids missing DLL exports in upstream's old MSVC CMake setup.
    file = ctb / 'src/CMakeLists.txt'
    file.write_text(file.read_text().replace('add_library(ctb SHARED', 'add_library(ctb STATIC'))
    run(
        'cmake',
        '-S',
        ctb,
        '-B',
        work / 'ctb-build',
        '-A',
        'x64',
        '-DCMAKE_POLICY_VERSION_MINIMUM=3.5',
        '-DCMAKE_TOOLCHAIN_FILE=' + str(vcpkg / 'scripts/buildsystems/vcpkg.cmake'),
        '-DVCPKG_TARGET_TRIPLET=x64-windows',
        '-DCMAKE_CXX_FLAGS=/D_USE_MATH_DEFINES /DNOMINMAX',
        '-DCMAKE_INSTALL_PREFIX=' + str(work / 'ctb-install'),
    )
    run('cmake', '--build', work / 'ctb-build', '--config', 'Release', '--parallel', '4')
    run('cmake', '--install', work / 'ctb-build', '--config', 'Release')
    shutil.copy2(work / 'ctb-install/bin/ctb-tile.exe', output / 'ctb-tile.exe')
    osgb = checkout(work, 'osgb', 'https://github.com/fanvanzh/3dtiles.git', OSGB_COMMIT)
    for file in (osgb / 'src').glob('*.cpp'):
        text = (
            file.read_text()
            .replace('"gdal/ogrsf_frmts.h"', '<ogrsf_frmts.h>')
            .replace('<gdal/ogrsf_frmts.h>', '<ogrsf_frmts.h>')
            .replace('<gdal/ogr_spatialref.h>', '<ogr_spatialref.h>')
        )
        file.write_text(text)
    file = osgb / 'src/tileset.cpp'
    text = (
        file.read_text()
        .replace(
            'CPLSetConfigOption("GDAL_DATA", path);',
            'if (!CPLGetConfigOption("GDAL_DATA", nullptr)) CPLSetConfigOption("GDAL_DATA", path);',
        )
        .replace(
            'outRs.importFromEPSG(4326);',
            'outRs.importFromEPSG(4326);\n inRs.SetAxisMappingStrategy(OAMS_TRADITIONAL_GIS_ORDER);\n outRs.SetAxisMappingStrategy(OAMS_TRADITIONAL_GIS_ORDER);',
        )
    )
    file.write_text(text)
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
    include = str(installed / 'include').replace('\\', '/')
    library = str(installed / 'lib').replace('\\', '/')
    (osgb / 'build.rs').write_text(
        """extern crate cc;
fn main() {
 cc::Build::new().cpp(true).flag("/std:c++14").warnings(false)
 .define("NOMINMAX", None).define("WIN32", None).define("_WINDOWS", None)
 .include("INCLUDE_PATH").include("./src")
 .file("./src/tileset.cpp").file("./src/shp23dtile.cpp").file("./src/osgb23dtile.cpp").file("./src/dxt_img.cpp").compile("_3dtile");
 println!("cargo:rustc-link-search=native=LIB_PATH");
 for lib in ["gdal", "OpenThreads", "osg", "osgDB", "osgUtil", "osgViewer"] { println!("cargo:rustc-link-lib={}", lib); }
}
""".replace('INCLUDE_PATH', include).replace('LIB_PATH', library)
    )
    run(
        'cargo',
        'build',
        '--release',
        '--target',
        'x86_64-pc-windows-msvc',
        '--manifest-path',
        osgb / 'Cargo.toml',
    )
    shutil.copy2(osgb / 'target/x86_64-pc-windows-msvc/release/_3dtile.exe', output / '3dtile.exe')
    tools = installed / 'tools/gdal'
    for name in ('gdal.exe', 'gdalwarp.exe'):
        source = tools / name
        if not source.exists():
            raise RuntimeError(f'Missing GDAL CLI: {source}')
        shutil.copy2(source, output / name)
    # Include every release DLL, so plugin-loaded dependencies are also available.
    for directory in (installed / 'bin', tools):
        for file in directory.glob('*.dll'):
            shutil.copy2(file, output / file.name)
    plugins = list(installed.rglob('osgPlugins-3.6.5'))
    plugins = [p for p in plugins if 'debug' not in p.parts and p.is_dir()]
    if not plugins:
        raise RuntimeError('OSG scene reader/serializer plugins are missing')
    for plugin in plugins:
        shutil.copytree(plugin, output / 'osgPlugins-3.6.5', dirs_exist_ok=True)
    for name in ('gdal', 'proj'):
        shutil.copytree(installed / 'share' / name, output / 'share' / name, dirs_exist_ok=True)
    # App-local Visual C++ runtime deployment; no redistributable installer needed.
    redist = Path(os.environ['VCToolsRedistDir'])
    crt = list(redist.glob('x64/Microsoft.VC*.CRT'))
    if not crt:
        raise RuntimeError('MSVC app-local runtime not found')
    for directory in crt:
        for file in directory.glob('*.dll'):
            shutil.copy2(file, output / file.name)
    notices = output / 'licenses'
    notices.mkdir(exist_ok=True)
    shutil.copy2(ctb / 'LICENSE.md', notices / 'CTB-LICENSE.txt')
    shutil.copy2(osgb / 'LICENSE', notices / '3DTILES-LICENSE.txt')
    for package in (installed / 'share').iterdir():
        license_file = package / 'copyright'
        if license_file.exists():
            target = notices / package.name
            target.mkdir(exist_ok=True)
            shutil.copy2(license_file, target / 'copyright')
    print('Windows native converter bundle ready:', output)


if __name__ == '__main__':
    main()
