"""Audit Windows PE architecture and app-local dependency closure before packaging."""

import os
import sys
from pathlib import Path

import pefile

root = Path(sys.argv[1]).resolve()
files = [p for p in root.rglob('*') if p.is_file() and p.suffix.lower() in ('.exe', '.dll', '.pyd')]
index = {p.name.lower(): p for p in files}
system = Path(os.environ['SystemRoot']) / 'System32'
checked = 0
for file in files:
    pe = pefile.PE(str(file), fast_load=True)
    # nginx.org's official Windows server is Win32 and runs under Windows x64's built-in WOW64.
    nginx = file.relative_to(root).as_posix() == 'nginx/nginx.exe'
    if pe.FILE_HEADER.Machine != 0x8664 and not (nginx and pe.FILE_HEADER.Machine == 0x14C):
        raise SystemExit(f'Not Windows x64 compatible: {file}')
    pe.parse_data_directories(
        directories=[
            pefile.DIRECTORY_ENTRY['IMAGE_DIRECTORY_ENTRY_IMPORT'],
            pefile.DIRECTORY_ENTRY['IMAGE_DIRECTORY_ENTRY_DELAY_IMPORT'],
        ]
    )
    imports = list(getattr(pe, 'DIRECTORY_ENTRY_IMPORT', [])) + list(
        getattr(pe, 'DIRECTORY_ENTRY_DELAY_IMPORT', [])
    )
    for entry in imports:
        name = entry.dll.decode('ascii').lower()
        if name in index or name.startswith(('api-ms-win-', 'ext-ms-win-')):
            continue
        # VC redistributables must be app-local even if the build runner installed them.
        redistributable = name.startswith(('vcruntime', 'msvcp', 'concrt'))
        if redistributable or not (system / name).is_file():
            raise SystemExit(f'Missing bundled dependency: {file}: {name}')
    pe.close()
    checked += 1
print(f'Checked {checked} PE files: app and processing engines are x64; dependency closure passed')
