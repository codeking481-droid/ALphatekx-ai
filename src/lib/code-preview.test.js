import test from 'node:test'
import assert from 'node:assert/strict'
import { buildCodePreviewDocument } from './code-preview.js'

test('code preview combines HTML, CSS, and JavaScript with restrictive browser policies', () => {
  const preview = buildCodePreviewDocument([
    '```html',
    '<!doctype html><html><head><title>Demo</title></head><body><main id="app">Demo</main></body></html>',
    '```',
    '```css',
    '#app { color: lime; }',
    '```',
    '```javascript',
    'document.querySelector("#app").dataset.ready = "true";',
    '```',
  ].join('\n'))

  assert.match(preview, /Content-Security-Policy/)
  assert.match(preview, /connect-src 'none'/)
  assert.match(preview, /script-src 'nonce-[a-f0-9]+'/)
  assert.doesNotMatch(preview, /script-src[^;]*unsafe-inline/)
  assert.match(preview, /<style>#app \{ color: lime; \}\n<\/style>/)
  assert.match(preview, /<script nonce="[a-f0-9]+">document\.querySelector\("#app"\)\.dataset\.ready = "true";\n<\/script>/)
})

test('CSS and JavaScript-only code gets a preview document scaffold', () => {
  const preview = buildCodePreviewDocument([
    '```css',
    '#app { color: hotpink; }',
    '```',
    '```js',
    'document.querySelector("#app").textContent = "Interactive";',
    '```',
  ].join('\n'))

  assert.match(preview, /id="app"/)
  assert.match(preview, /color: hotpink/)
  assert.match(preview, /<script nonce="[a-f0-9]+">document\.querySelector\("#app"\)\.textContent = "Interactive";\n<\/script>/)
})

test('unsupported code fences and oversized previews are not rendered', () => {
  assert.equal(buildCodePreviewDocument('```python\nprint("hello")\n```'), null)
  assert.equal(buildCodePreviewDocument(`\`\`\`html\n${'x'.repeat(256 * 1024)}\n\`\`\``), null)
})

test('code preview escapes closing raw-text tags in CSS and JavaScript blocks', () => {
  const preview = buildCodePreviewDocument([
    '```css',
    '.sample::after { content: "</style>"; }',
    '```',
    '```js',
    'const closingTag = "</script>";',
    '```',
  ].join('\n'))

  assert.match(preview, /<\\\/style>/)
  assert.match(preview, /<\\\/script>/)
})

test('code preview never nonce-authorizes external scripts', () => {
  const preview = buildCodePreviewDocument([
    '```html',
    '<!doctype html><html><head></head><body><script src="https://example.test/app.js"></script></body></html>',
    '```',
  ].join('\n'))

  assert.match(preview, /<script src="https:\/\/example\.test\/app\.js"><\/script>/)
  assert.doesNotMatch(preview, /<script nonce="[a-f0-9]+" src=/)
})
