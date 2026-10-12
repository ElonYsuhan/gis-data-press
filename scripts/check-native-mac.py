"""Fail packaging on missing native dependencies or architecture mismatches."""

import subprocess
import sys
from pathlib import Path

root = Path(sys.argv[1]).resolve()
checked = 0
for file in root.rglob('*'):
    if not file.is_file() or file.is_symlink():
        continue
    with file.open('rb') as stream:
        magic = stream.read(4)
    if magic not in (
        b'\xcf\xfa\xed\xfe',
        b'\xfe\xed\xfa\xcf',
        b'\xca\xfe\xba\xbe',
        b'\xbe\xba\xfe\xca',
    ):
        continue
    arch = subprocess.check_output(['lipo', '-archs', str(file)], text=True)
    if 'arm64' not in arch.split():
        raise SystemExit(f'Not Apple Silicon compatible: {file}: {arch}')
    identity = subprocess.check_output(['otool', '-D', str(file)], text=True).splitlines()[1:]
    for line in subprocess.check_output(['otool', '-L', str(file)], text=True).splitlines()[1:]:
        dependency = line.strip().split(' (')[0]
        if dependency in identity:
            continue
        if dependency.startswith(('/usr/lib/', '/System/')):
            continue
        if dependency.startswith('@loader_path/'):
            target = (file.parent / dependency[len('@loader_path/') :]).resolve()
            if not target.is_relative_to(root) or not target.is_file():
                raise SystemExit(f'Missing/outside bundle dependency: {file}: {dependency}')
        elif dependency.startswith('@rpath/'):
            details = subprocess.check_output(['otool', '-l', str(file)], text=True).splitlines()
            candidates = []
            for index, detail in enumerate(details):
                if 'cmd LC_RPATH' in detail:
                    entry = details[index + 2].strip().split('path ')[1].split(' (')[0]
                    entry = entry.replace('@loader_path', str(file.parent))
                    candidates.append((Path(entry) / dependency[len('@rpath/') :]).resolve())
            if not any(p.is_relative_to(root) and p.is_file() for p in candidates):
                raise SystemExit(f'Unresolved rpath dependency: {file}: {dependency}')

        else:
            raise SystemExit(f'External dependency: {file}: {dependency}')
    checked += 1
print(f'Checked {checked} Mach-O files: arm64, all non-system dependencies inside bundle')
