// Run once after editing public/logo.svg; requires installed Chrome and macOS iconutil for ICNS.
import { chromium } from 'playwright'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
const svg = await readFile('public/logo.svg', 'utf8')
const browser = await chromium.launch({ channel: 'chrome', headless: true })
await mkdir('resources/icons/app.iconset', { recursive: true })
try {
  for (const size of [16, 32, 48, 64, 128, 256, 512, 1024]) {
    const page = await browser.newPage({
      viewport: { width: size, height: size },
      deviceScaleFactor: 1,
    })
    await page.setContent(
      `<style>html,body{margin:0;background:transparent}svg{width:${size}px;height:${size}px;display:block}</style>${svg}`,
    )
    await page.screenshot({ path: `resources/icons/icon-${size}.png`, omitBackground: true })
    await page.close()
  }
} finally {
  await browser.close()
}
for (const [name, size] of Object.entries({
  icon_16x16: 16,
  'icon_16x16@2x': 32,
  icon_32x32: 32,
  'icon_32x32@2x': 64,
  icon_128x128: 128,
  'icon_128x128@2x': 256,
  icon_256x256: 256,
  'icon_256x256@2x': 512,
  icon_512x512: 512,
  'icon_512x512@2x': 1024,
})) {
  await writeFile(
    `resources/icons/app.iconset/${name}.png`,
    await readFile(`resources/icons/icon-${size}.png`),
  )
}
const sizes = [16, 32, 48, 64, 128, 256]
const images = await Promise.all(sizes.map((size) => readFile(`resources/icons/icon-${size}.png`)))
const header = Buffer.alloc(6 + 16 * sizes.length)
header.writeUInt16LE(1, 2)
header.writeUInt16LE(sizes.length, 4)
let offset = header.length
images.forEach((image, index) => {
  const pos = 6 + index * 16
  header[pos] = header[pos + 1] = sizes[index] === 256 ? 0 : sizes[index]
  header.writeUInt16LE(1, pos + 4)
  header.writeUInt16LE(32, pos + 6)
  header.writeUInt32LE(image.length, pos + 8)
  header.writeUInt32LE(offset, pos + 12)
  offset += image.length
})
await writeFile('resources/icons/app.ico', Buffer.concat([header, ...images]))
if (process.platform === 'darwin') {
  execFileSync('iconutil', [
    '-c',
    'icns',
    'resources/icons/app.iconset',
    '-o',
    'resources/icons/app.icns',
  ])
}
