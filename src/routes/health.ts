import { Router, Request, Response } from 'express'

const router = Router()

/**
 * Liveness check for Fly.io. Intentionally dependency-free: it must NOT query the
 * database. The web tier scales to zero, and a DB-dependent check trips on stale
 * pooled connections right after resume (and a DB blip must never make Fly pull or
 * restart the machine). Database/ingestion health is observed via the ingest
 * worker's freshness signal (watchdog + Sentry Crons + the ingest_last_success
 * metric), not here.
 */
router.get('/health', (_req: Request, res: Response) => {
  res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() })
})

export default router
