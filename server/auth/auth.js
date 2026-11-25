import { betterAuth } from 'better-auth'
import { twoFactor } from 'better-auth/plugins'
import { pool } from '../db/pool.js'
import { config } from '../config.js'
import { sendPasswordResetEmail } from './mail.js'

const googleConfigured = process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET

export const auth = betterAuth({
  database: pool,
  secret: config.authSecret,
  baseURL: config.authUrl,
  trustedOrigins: config.trustedOrigins,
  emailAndPassword: {
    enabled: true,
    requireEmailVerification: false,
    sendResetPassword: async ({ user, url }) => sendPasswordResetEmail(user.email, url),
  },
  appName: 'Biz',
  user: {
    additionalFields: {
      role: { type: 'string', required: false, defaultValue: 'user', input: false },
    },
  },
  ...(googleConfigured
    ? {
        socialProviders: {
          google: {
            clientId: process.env.GOOGLE_CLIENT_ID,
            clientSecret: process.env.GOOGLE_CLIENT_SECRET,
          },
        },
      }
    : {}),
  plugins: [twoFactor()],
  advanced: {
    useSecureCookies: config.isProduction,
    defaultCookieAttributes: {
      sameSite: 'lax',
      secure: config.isProduction,
    },
  },
})
