import express from 'express'
import { fileURLToPath } from 'node:url'
import { createAuth } from './auth.js'
import { createRoutes } from './routes.js'

const FRONTEND = fileURLToPath(new URL('../../frontend/', import.meta.url))

/** deps: { models: { Admin, Booking, RawMessage }, config, getHealthState, onConfirmed, logger } */
export function createApp(deps) {
  const { config, logger } = deps
  const auth = createAuth({ Admin: deps.models.Admin, config })
  const app = express()
  app.disable('x-powered-by')
  if (config.nodeEnv === 'production') app.set('trust proxy', 1)

  app.use((req, res, next) => {
    res.set({
      'Content-Security-Policy': "default-src 'self'; frame-ancestors 'none'",
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    })
    // JSON only on state-changing routes: an HTML form cannot send it, which with SameSite=Strict covers CSRF.
    if (req.method === 'POST' && !req.is('application/json')) {
      return res.status(415).json({ error: 'Send JSON (Content-Type: application/json).' })
    }
    next()
  })
  app.use(express.json({ limit: '16kb' }))

  app.use(express.static(FRONTEND))
  app.get('/login', (req, res) => res.sendFile('login.html', { root: FRONTEND }))
  app.post('/login', auth.login)

  app.use(['/api', '/health', '/export', '/logout'], auth.requireAuth)
  app.post('/logout', auth.logout)
  app.get('/api/me', (req, res) => res.json({ username: req.user }))
  app.use(createRoutes(deps))
  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }))

  app.use((err, req, res, next) => {
    if (res.headersSent) {
      logger.error({ err, method: req.method, path: req.path }, 'request failed mid-response')
      // Cut the connection so the client sees a failed download, not a truncated file.
      // Not next(err): Express's default handler would print the raw stack to stderr.
      return res.destroy()
    }
    // Client errors from body parsing (bad JSON, too large) and our own validation.
    if (err.expose && err.status >= 400 && err.status < 500) {
      return res.status(err.status).json({ error: err.type === 'entity.parse.failed' ? 'Body is not valid JSON.' : err.message })
    }
    logger.error({ err, method: req.method, path: req.path }, 'request failed')
    res.status(500).json({ error: 'Internal error' })
  })
  return app
}
