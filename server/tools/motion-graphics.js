import { createHash } from 'node:crypto'
import { saveUpload } from '../files/service.js'
import { registerTool } from './registry.js'

export const MAX_MOTION_HTML_BYTES = 256 * 1024
const MOTION_GRAPHIC_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; base-uri 'none'; form-action 'none'"
const BUILT_IN_TEMPLATE_MARKER = /<!-- BIZ_BUILT_IN_MOTION_TEMPLATE:(providers-unavailable|invalid-ai-output) -->/

function escapeHtml(value) {
  return value.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[character])
}

function getMotionTitle(message) {
  const subject = /\b(?:for|about|featuring|called|named)\s+["“]?([^.!?\n,"”]+)["”]?/i.exec(message)?.[1]
  const title = (subject || 'Biz').replace(/\b(?:using|with|in|on|as)\b.*$/i, '').trim()
  return title.slice(0, 80) || 'Biz'
}

function createDefaultMotionHtml(title) {
  const safeTitle = escapeHtml(title)
  return `<!doctype html>
<html lang="en">
<head>
  <title>${safeTitle} - Animated intro</title>
  <style>
    * { box-sizing: border-box; }
    body {
      display: grid;
      min-height: 100vh;
      margin: 0;
      overflow: hidden;
      place-items: center;
      background: radial-gradient(ellipse at 50% 42%, #193c2c 0%, #101a14 48%, #080c0a 100%);
      color: #f1f5f2;
      font-family: Inter, ui-sans-serif, system-ui, sans-serif;
    }
    main { position: relative; padding: 3rem 2rem; text-align: center; }
    .orbit {
      position: absolute;
      top: 50%;
      left: 50%;
      width: min(72vw, 32rem);
      aspect-ratio: 1;
      border: 1px solid rgb(112 220 157 / 22%);
      border-radius: 50%;
      transform: translate(-50%, -50%);
      animation: orbit 18s linear infinite;
    }
    .orbit::before, .orbit::after {
      position: absolute;
      width: .65rem;
      aspect-ratio: 1;
      border-radius: 50%;
      background: #75e2a2;
      box-shadow: 0 0 24px #75e2a2;
      content: "";
    }
    .orbit::before { top: 12%; left: 18%; }
    .orbit::after { right: 12%; bottom: 24%; width: .4rem; }
    .mark {
      display: inline-grid;
      min-width: 3.5rem;
      height: 3.5rem;
      margin-bottom: 1.5rem;
      place-items: center;
      border: 1px solid rgb(117 226 162 / 65%);
      border-radius: 1.1rem;
      padding: 0 1rem;
      color: #75e2a2;
      font-size: 1rem;
      font-weight: 700;
      letter-spacing: .12em;
      animation: arrive .8s cubic-bezier(.2,.8,.2,1) both;
    }
    h1 {
      max-width: 90vw;
      margin: 0;
      font-size: clamp(2.5rem, 9vw, 6rem);
      font-weight: 650;
      letter-spacing: -.06em;
      line-height: 1;
      animation: arrive .8s .12s cubic-bezier(.2,.8,.2,1) both;
    }
    p {
      margin: 1.25rem 0 0;
      color: #a9c1b1;
      font-size: clamp(.85rem, 2vw, 1rem);
      letter-spacing: .2em;
      text-transform: uppercase;
      animation: arrive .8s .24s cubic-bezier(.2,.8,.2,1) both;
    }
    @keyframes arrive {
      from { opacity: 0; transform: translateY(1.25rem) scale(.98); }
      to { opacity: 1; transform: translateY(0) scale(1); }
    }
    @keyframes orbit { to { transform: translate(-50%, -50%) rotate(360deg); } }
    @media (prefers-reduced-motion: reduce) {
      *, *::before, *::after { animation-duration: .01ms !important; animation-iteration-count: 1 !important; }
    }
  </style>
</head>
<body>
  <main aria-label="${safeTitle} animated intro">
    <div class="orbit" aria-hidden="true"></div>
    <div class="mark" aria-hidden="true">BIZ</div>
    <h1>${safeTitle}</h1>
    <p>Chat Connect Automate</p>
  </main>
</body>
</html>`
}

export function createBuiltInMotionInput(message, reason = 'providers-unavailable') {
  const title = getMotionTitle(typeof message === 'string' ? message : '')
  const safeReason = reason === 'invalid-ai-output' ? reason : 'providers-unavailable'
  const html = createDefaultMotionHtml(title).replace(
    /^(<!doctype html>)/i,
    `$1\n<!-- BIZ_BUILT_IN_MOTION_TEMPLATE:${safeReason} -->`,
  )
  const filename = `${title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 70) || 'biz'}-intro.html`
  return { filename, html }
}

export function isSafeMotionHtml(value) {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > MAX_MOTION_HTML_BYTES ||
    !/^\s*<!doctype html>/i.test(value) || !/<html\b[\s\S]*<\/html>\s*$/i.test(value)) return false
  return !/<\s*(script|iframe|object|embed|form|base|meta|foreignobject)\b/i.test(value) &&
    !/\son[a-z]+\s*=/i.test(value) &&
    !/\bjavascript\s*:/i.test(value) &&
    !/\b(?:src|href)\s*=\s*["']\s*(?:https?:|\/\/|data:text\/html)/i.test(value) &&
    !/\b(?:src|href)\s*=\s*(?:https?:|\/\/|data:text\/html)/i.test(value) &&
    !/@import\b/i.test(value) &&
    !/url\(\s*['"]?\s*(?:https?:|\/\/)/i.test(value)
}

export function registerMotionGraphicsTool() {
  return registerTool({
    id: 'motion_graphics_create',
    name: 'Create motion graphic',
    description: 'Create a new, prompt-specific downloadable HTML/CSS motion graphic. Use the user\'s requested subject, text, colors, shapes, composition, and movement; do not reuse a generic template. Keep it self-contained and inert: scripts, event handlers, and remote resources are prohibited.',
    inputSchema: {
      type: 'object',
      properties: {
        filename: { type: 'string', minLength: 1, maxLength: 100 },
        html: { type: 'string', minLength: 1, maxLength: MAX_MOTION_HTML_BYTES },
      },
      required: ['filename', 'html'],
      additionalProperties: false,
    },
    permissions: ['tool:approved'],
    requiresApproval: false,
    retrySafe: true,
    normalizeInput: (input, { message = '' } = {}) => {
      const title = getMotionTitle(message)
      const filename = typeof input.filename === 'string' &&
        /^[a-z0-9][a-z0-9-]{0,80}\.html$/i.test(input.filename)
        ? input.filename
        : `${title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 70) || 'biz'}-intro.html`
      return {
        filename,
        html: typeof input.html === 'string' ? input.html : '',
      }
    },
    auditDetails: (input) => ({
      filename: input.filename,
      bytes: Buffer.byteLength(input.html, 'utf8'),
      sha256: createHash('sha256').update(input.html).digest('hex'),
    }),
    validate: (input) => typeof input?.filename === 'string' &&
      /^[a-z0-9][a-z0-9-]{0,80}\.html$/i.test(input.filename) &&
      isSafeMotionHtml(input.html),
    execute: async ({ input, userId }) => {
      const html = input.html.replace(/<head\b[^>]*>/i, (head) =>
        `${head}<meta http-equiv="Content-Security-Policy" content="${MOTION_GRAPHIC_CSP}">`)
        .replace(/<html\b[^>]*>(?![\s\S]*<head\b)/i, (tag) =>
          `${tag}<head><meta http-equiv="Content-Security-Policy" content="${MOTION_GRAPHIC_CSP}"></head>`)
      const file = Buffer.from(html, 'utf8')
      const artifact = await saveUpload({
        userId,
        file: {
          buffer: file,
          originalname: input.filename,
          mimetype: 'text/html',
          size: file.length,
        },
      })
      const fallbackReason = BUILT_IN_TEMPLATE_MARKER.exec(input.html)?.[1] || null
      return {
        name: artifact.name,
        url: artifact.url,
        previewUrl: `${artifact.url}/preview`,
        size: artifact.size,
        generationSource: fallbackReason ? 'built-in-template' : 'ai-generated',
        ...(fallbackReason ? { fallbackReason } : {}),
        message: fallbackReason
          ? 'A built-in motion graphics template was used as the last resort; it is not AI-generated.'
          : 'A new AI-generated motion graphic is ready. Preview it in Biz or download the standalone file.',
      }
    },
    verifyResult: (result) => Boolean(result &&
      typeof result.name === 'string' &&
      typeof result.url === 'string' &&
      typeof result.previewUrl === 'string'),
  })
}
