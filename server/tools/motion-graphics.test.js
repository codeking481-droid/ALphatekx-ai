import test from 'node:test'
import assert from 'node:assert/strict'
import { parsePlanGraph } from '../intelligence/plan-graph.js'
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

test('motion plans safely default missing artifact fields instead of failing the request', () => {
  const unregister = registerMotionGraphicsTool()
  try {
    const graph = parsePlanGraph(JSON.stringify({
      tasks: [{
        id: 'make-intro',
        description: 'Create a motion graphics intro.',
        type: 'tool',
        requiredInputs: [{
          kind: 'tool_output',
          description: 'Generated animation file.',
          toolId: 'motion_graphics_create',
        }],
        dependencies: [],
        expectedOutput: 'A downloadable animated intro.',
        acceptanceCriteria: ['A safe HTML animation is created.'],
        riskClassification: 'low',
        requiredCapability: 'tool_execution',
        specialistRole: 'execution',
        maxAttempts: 1,
        completionConditions: ['The animation file is available.'],
      }],
    }), {
      allowedToolIds: ['motion_graphics_create'],
      requiresExternalAction: true,
      message: 'Make a motion graphics intro for Biz.',
      skill: { name: 'motion-graphics', tools: ['motion_graphics_create'] },
    })

    const input = graph.tasks[0].toolInput
    assert.equal(input.filename, 'biz-intro.html')
    assert.equal(isSafeMotionHtml(input.html), true)
    assert.match(input.html, /<h1>Biz<\/h1>/)
    assert.match(input.html, /prefers-reduced-motion/)

    const untrustedTitle = getTool('motion_graphics_create').normalizeInput({}, {
      message: 'Make an intro for <script>alert(1)</script>.',
    })
    assert.equal(isSafeMotionHtml(untrustedTitle.html), true)
    assert.match(untrustedTitle.html, /&lt;script&gt;/)
    assert.doesNotMatch(untrustedTitle.html, /<script>/)
  } finally {
    unregister()
  }
})
