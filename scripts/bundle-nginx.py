"""Bundle a local macOS Nginx and relocate its non-system dylibs."""
from pathlib import Path
import shutil
import subprocess
import sys
root = Path(__file__).resolve().parents[1]
source = shutil.which('nginx')
if not source: raise SystemExit('Install nginx or place your platform build in resources/engines/nginx/')
output = root / 'resources' / 'engines' / 'nginx'
output.mkdir(parents=True, exist_ok=True)
if sys.platform != 'darwin':
    shutil.copy2(source, output / Path(source).name)
    raise SystemExit('Copied executable; include the matching platform runtime dependencies before distributing.')
seen = {}
def bundle(source, name):
    source = str(Path(source).resolve())
    if source in seen: return seen[source]
    target = output / name
    shutil.copy2(source, target)
    target.chmod(0o755)
    seen[source] = target
    listing = subprocess.check_output(['otool','-L',source], text=True).splitlines()[1:]
    for line in listing:
        dependency = line.strip().split(' (')[0]
        if dependency == source or dependency.startswith(('/usr/lib/','/System/')): continue
        if dependency.startswith('@'): raise SystemExit('Unsupported relative dependency: '+dependency)
        resolved = str(Path(dependency).resolve())
        if resolved == source: continue
        bundled = bundle(resolved, Path(dependency).name)
        subprocess.run(['install_name_tool','-change',dependency,'@loader_path/'+bundled.name,str(target)], check=True)
    if target.suffix == '.dylib': subprocess.run(['install_name_tool','-id','@loader_path/'+target.name,str(target)], check=True)
    subprocess.run(['codesign','--force','--sign','-',str(target)],check=True)
    return target
binary = bundle(source,'nginx')
subprocess.run([str(binary),'-v'],check=True)
print('Bundled Nginx:',binary)
