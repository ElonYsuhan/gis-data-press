"""Bundle native converters and recursively relocate all non-system Mach-O dependencies."""

import argparse
import json
import shutil
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / 'resources/engines'
seen = {}


def run(*args):
    return subprocess.check_output(args, text=True)


def bundle(source, target):
    source = Path(source).resolve()
    if source in seen:
        return seen[source]
    if not source.is_file():
        raise ValueError(f'Missing native dependency: {source}')
    if target.exists() and target.resolve() != source:
        target.unlink()
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, target)
    target.chmod(0o755)
    seen[source] = target
    rpaths = []
    lines = run('otool', '-l', str(source)).splitlines()
    for index, line in enumerate(lines):
        if 'cmd LC_RPATH' in line:
            rpaths.append(lines[index + 2].strip().split('path ')[1].split(' (')[0])
    for line in run('otool', '-L', str(source)).splitlines()[1:]:
        dep = line.strip().split(' (')[0]
        if dep.startswith(('/usr/lib/', '/System/')):
            continue
        candidate = dep.replace('@loader_path', str(source.parent)).replace(
            '@executable_path', str(source.parent)
        )
        if dep.startswith('@rpath/'):
            name = dep[len('@rpath/') :]
            search = [Path(p.replace('@loader_path', str(source.parent))) / name for p in rpaths]
            search += [
                source.parent / name,
                source.parent.parent / 'lib' / name,
                Path('/opt/homebrew/lib') / name,
            ]
            candidate = next((str(p) for p in search if p.is_file()), candidate)
        resolved = Path(candidate).resolve()
        if resolved == source:
            continue
        bundled = bundle(resolved, OUTPUT / 'lib' / resolved.name)
        import os

        relative = os.path.relpath(bundled, target.parent)
        subprocess.run(
            ['install_name_tool', '-change', dep, '@loader_path/' + relative, str(target)],
            check=True,
        )
    for rpath in rpaths:
        if rpath.startswith(('/opt/', '/Users/', '/tmp/')):
            subprocess.run(['install_name_tool', '-delete_rpath', rpath, str(target)], check=True)
    if target.suffix in ('.dylib', '.so'):
        subprocess.run(
            ['install_name_tool', '-id', '@loader_path/' + target.name, str(target)], check=True
        )
    subprocess.run(
        ['codesign', '--force', '--sign', '-', str(target)], check=True, capture_output=True
    )
    return target


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--ctb', required=True)
    parser.add_argument('--osgb', required=True)
    args = parser.parse_args()
    for source, name in [
        (args.ctb, 'ctb-tile'),
        (args.osgb, '3dtile'),
        ('/opt/homebrew/bin/gdal', 'gdal'),
        ('/opt/homebrew/bin/gdalwarp', 'gdalwarp'),
    ]:
        bundle(source, OUTPUT / name)
    # Binary OSGB scene readers, serializer modules and common embedded texture formats.
    plugins = Path('/opt/homebrew/lib/osgPlugins-3.6.5')
    for source in plugins.glob('*.so'):
        if source.stem in (
            'osgdb_osg',
            'osgdb_png',
            'osgdb_jpeg',
            'osgdb_dds',
            'osgdb_tga',
            'osgdb_rgb',
            'osgdb_bmp',
            'osgdb_tiff',
        ) or source.stem.startswith('osgdb_serializers_'):
            bundle(source, OUTPUT / 'osgPlugins-3.6.5' / source.name)
    for name in ('gdal', 'proj'):
        shutil.copytree('/opt/homebrew/share/' + name, OUTPUT / 'share' / name, dirs_exist_ok=True)
    notices = OUTPUT / 'licenses'
    notices.mkdir(exist_ok=True)
    versions = {}
    for source in seen:
        if not str(source).startswith('/opt/homebrew/Cellar/'):
            continue
        parts = source.relative_to('/opt/homebrew/Cellar').parts
        name, version = parts[:2]
        if name in versions:
            continue
        versions[name] = version
        keg = Path('/opt/homebrew/Cellar') / name / version
        for file in keg.rglob('*'):
            if not file.is_file() or file.suffix in ('.dylib', '.so', '.a'):
                continue
            if (
                'license' in file.name.lower()
                or 'copying' in file.name.lower()
                or file.name.lower() == 'copyright'
                or file.suffix == '.rb'
            ):
                target = notices / name / file.relative_to(keg)
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(file, target)
    (notices / 'native-versions.json').write_text(json.dumps(versions, indent=2))
    print(f'Bundled {len(seen)} native executables, libraries and plugins')


if __name__ == '__main__':
    main()
