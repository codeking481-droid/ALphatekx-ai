import { createHash } from 'node:crypto'
import { saveUpload } from '../files/service.js'
import { registerTool } from './registry.js'

export const MAX_MOTION_HTML_BYTES = 256 * 1024
const MOTION_GRAPHIC_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; base-uri 'none'; form-action 'none'"

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
    description: 'Create a downloadable, self-contained HTML motion graphic using inert HTML and CSS only. Generated code is never run on the server.',
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
      return {
        name: artifact.name,
        url: artifact.url,
        previewUrl: `${artifact.url}/preview`,
        size: artifact.size,
        message: 'Motion graphic HTML was created. Preview it in Biz or download the standalone file.',
      }
    },
    verifyResult: (result) => Boolean(result &&
      typeof result.name === 'string' &&
      typeof result.url === 'string' &&
      typeof result.previewUrl === 'string'),
  })
}
