import test from 'node:test'
import assert from 'node:assert/strict'
import { getTool } from './registry.js'
import { isSafeMotionHtml, registerMotionGraphicsTool } from './motion-graphics.js'

test('motion graphic output permits inert CSS animation and rejects active or external content', () => {
  const unregister = registerMotionGraphicsTool()
  try {
    const tool = getTool('motion_graphics_create')
    const safeHtml = '<!doctype html><html><head><style>@keyframes intro { from {opacity:0} to {opacity:1} }</style></head><body><h1>Biz</h1></body></html>'
    assert.equal(isSafeMotionHtml(safeHtml), true)
    assert.equal(tool.validate({ filename: 'biz-intro.html', html: safeHtml }), true)
    assert.equal(isSafeMotionHtml(safeHtml.replace('</body>', '<script>alert(1)</script></body>')), false)
    assert.equal(isSafeMotionHtml(safeHtml.replace('</body>', '<img src=https://example.com/a.png></body>')), false)
    assert.equal(tool.validate({ filename: '../biz.html', html: safeHtml }), false)
  } finally {
    unregister()
  }
})
