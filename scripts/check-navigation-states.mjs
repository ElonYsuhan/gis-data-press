import { _electron as electron } from 'playwright'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import assert from 'node:assert/strict'
import { cleanupTestService } from './cleanup-test-service.mjs'

const state = await mkdtemp(path.join(os.tmpdir(), 'geopress-nav-'))
const app = await electron.launch({
  executablePath:
    process.env.GEOPRESS_TEST_EXECUTABLE ??
    path.resolve('release/mac-arm64/GeoPress.app/Contents/MacOS/GeoPress'),
  args: ['--user-data-dir=' + path.join(state, 'desktop')],
  env: { ...process.env, GEOPRESS_STATE: state },
})
try {
  const page = await app.firstWindow()
  const active = page.getByRole('button', { name: '数据处理', exact: true })
  await active.click()
  const idle = page.locator('.sidebar nav').getByRole('button', { name: '任务中心', exact: true })
  await idle.hover()
  await page.waitForFunction(() => {
    const button = [...document.querySelectorAll('.sidebar nav button')].find(
      (item) => item.textContent.trim() === '任务中心',
    )
    return (
      button &&
      getComputedStyle(button).color === 'rgb(255, 255, 255)' &&
      getComputedStyle(button).backgroundColor === 'rgb(31, 51, 78)'
    )
  })
  const hover = await idle.evaluate((button) => ({
    color: getComputedStyle(button).color,
    background: getComputedStyle(button).backgroundColor,
  }))
  assert.equal(hover.color, 'rgb(255, 255, 255)')
  assert.equal(hover.background, 'rgb(31, 51, 78)')
  assert.equal(await active.evaluate((button) => getComputedStyle(button).outlineStyle), 'none')
  await active.hover()
  assert.equal(
    await active.evaluate((button) => getComputedStyle(button).color),
    'rgb(255, 255, 255)',
  )
  await page.keyboard.press('Tab')
  const focus = await idle.evaluate((button) => ({
    visible: button.matches(':focus-visible'),
    width: getComputedStyle(button).outlineWidth,
    offset: getComputedStyle(button).outlineOffset,
  }))
  assert.ok(focus.visible)
  assert.equal(focus.width, '2px')
  assert.equal(focus.offset, '-3px')
  await mkdir('output/playwright', { recursive: true })
  await page.screenshot({ path: 'output/playwright/navigation-keyboard-focus.png' })
  await active.click()
  await idle.hover()
  await page.screenshot({ path: 'output/playwright/navigation-hover.png' })
  console.log('Sidebar mouse hover, selected state, and inset keyboard focus passed')
} finally {
  await app.close()
  await cleanupTestService(state)
  await rm(state, { recursive: true, force: true })
}
