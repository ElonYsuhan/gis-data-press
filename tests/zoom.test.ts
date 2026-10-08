import test from 'node:test'
import assert from 'node:assert/strict'
import { metresAtZoom, zoomForMetres } from '../src/features/processing/domain/zoom'
test('XYZ ground resolution, latitude correction, and conservative zoom rounding', () => {
  assert.equal(zoomForMetres('imagery', 5), 15)
  assert.ok(Math.abs(metresAtZoom('imagery', 16) - 2.388657) < 0.00001)
  assert.equal(zoomForMetres('imagery', 5, 60), 14)
  for (const z of [0, 8, 15, 22]) {
    assert.equal(zoomForMetres('imagery', metresAtZoom('imagery', z)), z)
  }
})
test('CTB geographic terrain grid converts 30m to level 14 independently of latitude', () => {
  assert.equal(zoomForMetres('terrain', 30), 14)
  assert.equal(zoomForMetres('terrain', 30, 60), 14)
  assert.ok(metresAtZoom('terrain', 14) <= 30)
  assert.ok(metresAtZoom('terrain', 13) > 30)
  assert.throws(() => zoomForMetres('terrain', 0))
  assert.throws(() => zoomForMetres('imagery', NaN))
  assert.throws(() => zoomForMetres('imagery', 5, 90))
})
