param([Parameter(Mandatory=$true)][string]$VcpkgRoot)
$ErrorActionPreference = 'Stop'
$env:VCPKG_DEFAULT_TRIPLET = 'x64-windows'
& "$VcpkgRoot/vcpkg.exe" install 'gdal[core,tools,png,jpeg,sqlite3,geos]:x64-windows' 'osg[core,plugins]:x64-windows' --clean-after-build
if ($LASTEXITCODE -ne 0) { throw 'Native dependency build failed' }
& python scripts/windows/build-converters.py --vcpkg "$VcpkgRoot"
if ($LASTEXITCODE -ne 0) { throw 'Converter build failed' }
$nginxVersion = '1.30.5'
$nginxZip = Join-Path $env:RUNNER_TEMP 'nginx.zip'
Invoke-WebRequest "https://nginx.org/download/nginx-$nginxVersion.zip" -OutFile $nginxZip
$nginxDir = Join-Path $env:RUNNER_TEMP 'nginx-source'
Expand-Archive $nginxZip $nginxDir -Force
New-Item -ItemType Directory -Force resources/engines/nginx | Out-Null
Copy-Item "$nginxDir/nginx-$nginxVersion/nginx.exe" resources/engines/nginx/nginx.exe
Copy-Item "$nginxDir/nginx-$nginxVersion/LICENSE" resources/engines/licenses/NGINX-LICENSE.txt
& python scripts/bundle-worker.py
if ($LASTEXITCODE -ne 0) { throw 'Python runtime bundle failed' }
'{"platform":"win32","arch":"x64"}' | Set-Content -Encoding ascii resources/engines/platform.json
& python scripts/check-native-win.py resources/engines
if ($LASTEXITCODE -ne 0) { throw 'Runtime dependency audit failed' }
