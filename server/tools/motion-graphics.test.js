import test from 'node:test'
import assert from 'node:assert/strict'
import { buildPlanMessages, createFallbackToolPlan, parsePlanGraph } from '../intelligence/plan-graph.js'
import { getTool } from './registry.js'
import {
  createBuiltInMotionInput,
  isSafeMotionHtml,
  registerMotionGraphicsTool,
} from './motion-graphics.js'

test('motion graphic output permits isolated inline animation scripts and rejects unsafe external content', () => {
  const unregister = registerMotionGraphicsTool()
  try {
    const tool = getTool('motion_graphics_create')
    const safeHtml = '<!doctype html><html><head><style>@keyframes intro { from {opacity:0} to {opacity:1} }</style></head><body><h1>Biz</h1></body></html>'
    assert.equal(isSafeMotionHtml(safeHtml), true)
    assert.equal(tool.validate({ filename: 'biz-intro.html', html: safeHtml }), true)
    assert.equal(tool.normalizeInput({ filename: 'biz-intro.html', html: safeHtml }).html, safeHtml)
    const inlineScriptHtml = safeHtml.replace('</body>', '<script>document.body.dataset.ready = "true"</script></body>')
    assert.equal(isSafeMotionHtml(inlineScriptHtml), true)
    assert.equal(tool.validate({ filename: 'biz-intro.html', html: inlineScriptHtml }), true)
    assert.equal(isSafeMotionHtml(safeHtml.replace('</body>', '<script src="/app.js"></script></body>')), false)
    assert.equal(isSafeMotionHtml(safeHtml.replace('</body>', '<img src=x onerror=alert(1)></body>')), false)
    assert.equal(isSafeMotionHtml(safeHtml.replace('</body>', '<img src=https://example.com/a.png></body>')), false)
    assert.equal(tool.validate({ filename: '../biz.html', html: safeHtml }), false)
  } finally {
    unregister()
  }
})

test('motion plans reject missing or unsafe generated HTML rather than silently using a template', () => {
  const unregister = registerMotionGraphicsTool()
  try {
    const plan = JSON.stringify({
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
    })
    assert.throws(() => parsePlanGraph(plan, {
      allowedToolIds: ['motion_graphics_create'],
      requiresExternalAction: true,
      message: 'Make a motion graphics intro for Biz.',
      skill: { name: 'motion-graphics', tools: ['motion_graphics_create'] },
    }), /missing required information/)

    const tool = getTool('motion_graphics_create')
    const emptyInput = tool.normalizeInput({}, { message: 'Make an intro for Biz.' })
    assert.equal(emptyInput.filename, 'biz-intro.html')
    assert.equal(emptyInput.html, '')
    assert.equal(tool.validate(emptyInput), false)

    const inlineScriptInput = tool.normalizeInput({
      html: '<!doctype html><html><head></head><body><script>document.body.dataset.ready = "true"</script></body></html>',
    }, { message: 'Make an intro for Biz.' })
    assert.equal(tool.validate(inlineScriptInput), true)

    const fallback = createBuiltInMotionInput('Make an intro for Biz.')
    assert.equal(isSafeMotionHtml(fallback.html), true)
    assert.match(fallback.html, /BIZ_BUILT_IN_MOTION_TEMPLATE:providers-unavailable/)
    assert.match(fallback.html, /<h1>Biz<\/h1>/)
    assert.match(fallback.html, /prefers-reduced-motion/)
  } finally {
    unregister()
  }
})

test('local fallback plans mark their motion artifact as a built-in template', () => {
  const unregister = registerMotionGraphicsTool()
  try {
    const graph = createFallbackToolPlan({
      message: 'Make a motion graphics intro for Biz.',
      allowedToolIds: ['motion_graphics_create'],
    })
    assert.equal(isSafeMotionHtml(graph.tasks[0].toolInput.html), true)
    assert.match(graph.tasks[0].toolInput.html, /BIZ_BUILT_IN_MOTION_TEMPLATE:invalid-ai-output/)

    const regenerated = createFallbackToolPlan({
      message: 'Make it different',
      allowedToolIds: ['motion_graphics_create'],
    })
    assert.equal(isSafeMotionHtml(regenerated.tasks[0].toolInput.html), true)
  } finally {
    unregister()
  }
})

test('motion planning explicitly requests prompt-specific, distinct HTML and CSS', () => {
  const unregister = registerMotionGraphicsTool()
  try {
    const [system] = buildPlanMessages({
      message: 'Create a motion graphics intro for Biz',
      objective: {},
      allowedToolIds: ['motion_graphics_create'],
    })
    assert.match(system.content, /original HTML document/)
    assert.match(system.content, /clearly different design/)
    assert.match(system.content, /inline JavaScript is allowed only for local animation or interaction/)
    assert.match(system.content, /Do not use event-handler attributes/)
  } finally {
    unregister()
  }
})
