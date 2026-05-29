import express from 'express'
import request from 'supertest'
import healthRouter from '../../../src/routes/health'
import { pool } from '../../../src/config/database'

describe('GET /health (liveness)', () => {
  const app = express()
  app.use('/', healthRouter)

  it('returns 200 ok without querying the database', async () => {
    const querySpy = vi.spyOn(pool, 'query')

    const res = await request(app).get('/health')

    expect(res.status).toBe(200)
    expect(res.body.status).toBe('ok')
    expect(typeof res.body.timestamp).toBe('string')
    expect(querySpy).not.toHaveBeenCalled()

    querySpy.mockRestore()
  })
})
