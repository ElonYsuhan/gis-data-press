const fs = require('node:fs')
const path = require('node:path')
module.exports = async (context) => {
  const platform = context.electronPlatformName
  const arch = require('builder-util').Arch[context.arch]
  if (platform !== process.platform || arch !== process.arch) {
    throw new Error(
      `请在 ${platform}/${arch} 原生环境构建，当前为 ${process.platform}/${process.arch}`,
    )
  }
  const root = path.resolve('resources/engines')
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'platform.json'), 'utf8'))
  if (manifest.platform !== platform || manifest.arch !== arch) {
    throw new Error('内置引擎平台不匹配，请先准备目标系统的 Nginx 和 Python worker')
  }
  for (const file of [
    platform === 'win32' ? 'nginx/nginx.exe' : 'nginx/nginx',
    platform === 'win32' ? 'python/gis-worker/gis-worker.exe' : 'python/gis-worker/gis-worker',
    'ctb-tile' + (platform === 'win32' ? '.exe' : ''),
    '3dtile' + (platform === 'win32' ? '.exe' : ''),
    'gdal' + (platform === 'win32' ? '.exe' : ''),
    'gdalwarp' + (platform === 'win32' ? '.exe' : ''),
    'share/proj/proj.db',
  ]) {
    if (!fs.existsSync(path.join(root, file))) {
      throw new Error(`安装包缺少引擎: ${file}`)
    }
  }
  if (platform === 'win32') {
    require('node:child_process').execFileSync('python', ['scripts/check-native-win.py', root], {
      stdio: 'inherit',
    })
  }
  if (platform === 'darwin') {
    require('node:child_process').execFileSync(
      '/usr/bin/python3',
      ['scripts/check-native-mac.py', root],
      { stdio: 'inherit' },
    )
  }
}
