import { auth } from './auth.js'
import { fromNodeHeaders } from 'better-auth/node'

export function createRequireUser(getSession = (headers) => auth.api.getSession({ headers })) {
  return async function requireUser(req, res, next) {
    try {
      const session = await getSession(fromNodeHeaders(req.headers))
      if (!session?.user?.id) return res.status(401).json({ error: 'Authentication required' })
      req.user = session.user
      req.session = session.session
      next()
    } catch (error) {
      next(error)
    }
  }
}

export const requireUser = createRequireUser()
