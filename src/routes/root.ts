import { Router, Request, Response } from 'express'

const router = Router()

/**
 * Service descriptor for the bare host, so an uptime checker, curl or browser hitting
 * `/` gets something self-describing instead of Express's unmatched-route 404. Touches
 * neither the database nor the NMS upstream.
 */
router.get('/', (_req: Request, res: Response) => {
  res.json({
    name: 'notam-service',
    status: 'ok',
    endpoints: {
      health: '/health',
      metrics: '/metrics',
      notams: '/api/notams',
    },
  })
})

export default router
