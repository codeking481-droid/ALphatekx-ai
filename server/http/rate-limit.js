const MAX_BUCKETS = 10_000

export function createRateLimiter({
  limit,
  windowMs,
  key = (req) => req.user?.id,
  now = Date.now,
} = {}) {
  if (!Number.isInteger(limit) || limit < 1 || !Number.isInteger(windowMs) || windowMs < 1) {
    throw new TypeError('A rate limiter requires a positive integer limit and window.')
  }

  const buckets = new Map()

  return function rateLimit(req, res, next) {
    const identity = key(req)
    if (typeof identity !== 'string' || !identity) {
      return res.status(401).json({ error: 'Authentication required.', requestId: req.requestId })
    }

    const currentTime = now()
    let bucket = buckets.get(identity)
    if (!bucket || currentTime >= bucket.resetAt) {
      if (!bucket && buckets.size >= MAX_BUCKETS) {
        for (const [id, entry] of buckets) {
          if (currentTime >= entry.resetAt) buckets.delete(id)
        }
        if (buckets.size >= MAX_BUCKETS) {
          return res.status(503).json({ error: 'Rate limiting is temporarily unavailable.', requestId: req.requestId })
        }
      }
      bucket = { count: 0, resetAt: currentTime + windowMs }
      buckets.set(identity, bucket)
    }

    const remaining = Math.max(0, limit - bucket.count - 1)
    const resetSeconds = Math.max(1, Math.ceil((bucket.resetAt - currentTime) / 1000))
    res.setHeader('RateLimit-Policy', `${limit};w=${Math.ceil(windowMs / 1000)}`)
    res.setHeader('RateLimit-Limit', String(limit))
    res.setHeader('RateLimit-Remaining', String(remaining))
    res.setHeader('RateLimit-Reset', String(resetSeconds))

    if (bucket.count >= limit) {
      res.setHeader('Retry-After', String(resetSeconds))
      return res.status(429).json({ error: 'Too many chat requests. Please try again shortly.', requestId: req.requestId })
    }

    bucket.count += 1
    next()
  }
}
