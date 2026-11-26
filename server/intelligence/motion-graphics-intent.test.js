import test from 'node:test'
import assert from 'node:assert/strict'
import {
  builtInMotionGraphicsReply,
  isMotionGraphicsRegeneration,
  isMotionGraphicsRequest,
} from './motion-graphics-intent.js'

const priorAnimation = [{
  role: 'assistant',
  content: 'Preview: /api/files/2d9d4c77-8993-42ea-a893-b390f1917081/preview',
}]

test('motion graphics regeneration is recognized only when the conversation has an animation', () => {
  assert.equal(isMotionGraphicsRegeneration('Make it different', priorAnimation), true)
  assert.equal(isMotionGraphicsRequest('Make another one', priorAnimation), true)
  assert.equal(isMotionGraphicsRegeneration('Make it different', []), false)
  assert.equal(isMotionGraphicsRequest('Make it different', []), false)
  assert.equal(isMotionGraphicsRequest('Create an animated text intro', []), true)
})

test('built-in motion graphics disclosure identifies the template and keeps preview and download links', () => {
  const reply = builtInMotionGraphicsReply({
    fallbackReason: 'providers-unavailable',
    previewUrl: '/api/files/2d9d4c77-8993-42ea-a893-b390f1917081/preview',
    url: '/api/files/2d9d4c77-8993-42ea-a893-b390f1917081',
  })

  assert.match(reply, /AI providers were down/)
  assert.match(reply, /built-in template, not AI-generated/)
  assert.match(reply, /Retry in 2 mins/)
  assert.match(reply, /\[Preview the animation\]\(\/api\/files\/.*\/preview\)/)
  assert.match(reply, /\[Download the HTML\]\(\/api\/files\//)
})
