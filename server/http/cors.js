const ALLOWED_METHODS = 'GET, POST, PUT, PATCH, DELETE, OPTIONS'

export function createCorsMiddleware(allowedOrigin) {
  return (req, res, next) => {
    const origin = req.get('origin')
    if (origin && origin !== allowedOrigin) {
      return res.status(403).json({ error: 'Request origin is not allowed.' })
    }

    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin)
      res.setHeader('Access-Control-Allow-Credentials', 'true')
      res.setHeader('Vary', 'Origin')
    }

    if (req.method === 'OPTIONS') {
      if (!origin) return res.sendStatus(204)
      res.setHeader('Access-Control-Allow-Methods', ALLOWED_METHODS)
      const requestedHeaders = req.get('access-control-request-headers')
      if (requestedHeaders) res.setHeader('Access-Control-Allow-Headers', requestedHeaders)
      res.setHeader('Access-Control-Max-Age', '600')
      return res.sendStatus(204)
    }

    next()
  }
}
