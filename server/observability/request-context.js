import { randomUUID } from 'node:crypto'
import { log } from './logger.js'

export function requestContext(req, res, next) {
  const requestId = randomUUID()
  const startedAt = process.hrtime.bigint()
  req.requestId = requestId
  res.setHeader('X-Request-Id', requestId)
  res.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6
    log(res.statusCode >= 500 ? 'error' : 'info', 'http.request.completed', {
      requestId,
      method: req.method,
      path: req.path,
      status: res.statusCode,
      durationMs: Math.round(durationMs * 100) / 100,
    })
  })
  next()
}
