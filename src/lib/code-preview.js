const MAX_PREVIEW_BYTES = 256 * 1024
const CODE_FENCE = /```([^\r\n`]*)\r?\n([\s\S]*?)```/g
const LANGUAGE_TYPES = new Map([
  ['html', 'html'],
  ['htm', 'html'],
  ['css', 'css'],
  ['js', 'javascript'],
  ['javascript', 'javascript'],
])

export function buildCodePreviewDocument(markdown) {
  if (typeof markdown !== 'string' || new TextEncoder().encode(markdown).byteLength > MAX_PREVIEW_BYTES) {
    return null
  }

  const blocks = []
  for (const match of markdown.matchAll(CODE_FENCE)) {
    const language = match[1].trim().split(/\s+/, 1)[0].toLowerCase()
    const type = LANGUAGE_TYPES.get(language)
    if (type) blocks.push({ type, source: match[2] })
  }
  if (!blocks.length) return null

  const htmlBlock = blocks.find((block) => block.type === 'html')
  const css = blocks.filter((block) => block.type === 'css').map((block) => block.source).join('\n')
  const javascript = blocks
    .filter((block) => block.type === 'javascript')
    .map((block) => block.source)
    .join('\n;\n')
  let document = htmlBlock ? normalizeHtmlDocument(htmlBlock.source) : createPreviewScaffold()
  const nonce = createNonce()

  document = addPreviewPolicy(document, nonce)
  document = addScriptNonces(document, nonce)
  if (css) {
    document = insertBeforeClosingTag(document, 'head', `<style>${escapeRawText(css, 'style')}</style>`)
  }
  if (javascript) {
    document = insertBeforeClosingTag(
      document,
      'body',
      `<script nonce="${nonce}">${escapeRawText(javascript, 'script')}</script>`,
    )
  }
  return document
}

function normalizeHtmlDocument(source) {
  if (/<html\b/i.test(source)) return source
  const body = source.replace(/^\s*<!doctype\s+html\s*>/i, '')
  return `<!doctype html><html><head></head><body>${body}</body></html>`
}

function createPreviewScaffold() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Code preview</title>
  <style>
    * { box-sizing: border-box; }
    body { min-height: 100vh; margin: 0; padding: 2rem; background: #101713; color: #f1f5f2; font: 16px/1.5 system-ui, sans-serif; }
    #app { max-width: 42rem; margin: 10vh auto; padding: 2rem; border: 1px solid #31513e; border-radius: 1rem; background: #18251d; }
    button { border: 0; border-radius: .5rem; padding: .65rem 1rem; background: #75e2a2; color: #101713; font: inherit; cursor: pointer; }
  </style>
</head>
<body>
  <main id="app">
    <h1>Code preview</h1>
    <p>HTML, CSS, or JavaScript from this message is running in this isolated frame.</p>
    <button id="preview-button" type="button">Preview interaction</button>
  </main>
</body>
</html>`
}

function addPreviewPolicy(document, nonce) {
  const policy = `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; img-src data: blob:; media-src data: blob:; font-src data:; connect-src 'none'; object-src 'none'; frame-src 'none'; worker-src 'none'; base-uri 'none'; form-action 'none'`
  const policyMeta = `<meta http-equiv="Content-Security-Policy" content="${policy}">`

  if (/<head\b[^>]*>/i.test(document)) {
    if (/<\/head\s*>/i.test(document)) {
      return document.replace(/<head\b[^>]*>/i, (head) => `${head}${policyMeta}`)
    }
    return document.replace(/<head\b[^>]*>/i, (head) => `${head}${policyMeta}</head>`)
  }
  return document.replace(/<html\b[^>]*>/i, (html) => `${html}<head>${policyMeta}</head>`)
}

function addScriptNonces(document, nonce) {
  return document.replace(/<script\b([^>]*)>/gi, (_, attributes) => {
    const remainingAttributes = attributes.replace(/\snonce\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]*)/gi, '')
    const nonceAttribute = /\bsrc\s*=/i.test(remainingAttributes) ? '' : ` nonce="${nonce}"`
    return `<script${nonceAttribute}${remainingAttributes}>`
  })
}

function insertBeforeClosingTag(document, tag, content) {
  const closingTag = new RegExp(`</${tag}\\s*>`, 'i')
  const match = closingTag.exec(document)
  if (match) return `${document.slice(0, match.index)}${content}${document.slice(match.index)}`
  if (tag === 'head') return document.replace(/<html\b[^>]*>/i, (html) => `${html}<head>${content}</head>`)
  if (tag === 'body') {
    const htmlEnd = /<\/html\s*>/i.exec(document)
    if (htmlEnd) return `${document.slice(0, htmlEnd.index)}${content}${document.slice(htmlEnd.index)}`
  }
  return `${document}${content}`
}

function escapeRawText(source, tag) {
  return source.replace(new RegExp(`</${tag}`, 'gi'), `<\\/${tag}`)
}

function createNonce() {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
    byte.toString(16).padStart(2, '0')).join('')
}
