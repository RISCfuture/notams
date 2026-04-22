import { NOTAMModel, NOTAM } from '../../../src/models/notam'
import { readFileSync } from 'fs'
import { join } from 'path'

describe('NOTAMModel', () => {
  let notamModel: NOTAMModel
  let sampleNotams: NOTAM[]

  beforeEach(() => {
    notamModel = new NOTAMModel()

    const fixturesPath = join(__dirname, '../../fixtures/sample-notams.json')
    sampleNotams = JSON.parse(readFileSync(fixturesPath, 'utf-8'))

    // Convert date strings to Date objects
    sampleNotams = sampleNotams.map((notam) => ({
      ...notam,
      effective_start: new Date(notam.effective_start),
      effective_end: notam.effective_end ? new Date(notam.effective_end) : null,
    }))
  })

  describe('create', () => {
    it('should create a new NOTAM', async () => {
      const notam = sampleNotams[0]
      const created = await notamModel.create(notam)

      expect(created.id).toBeDefined()
      expect(created.notam_id).toBe(notam.notam_id)
      expect(created.icao_location).toBe(notam.icao_location)
      expect(created.notam_text).toBe(notam.notam_text)
    })

    it('should update existing NOTAM on conflict', async () => {
      const notam = sampleNotams[0]

      // Create first time
      const created = await notamModel.create(notam)

      // Update with same notam_id
      const updated = await notamModel.create({
        ...notam,
        notam_text: 'UPDATED TEXT',
      })

      expect(updated.id).toBe(created.id)
      expect(updated.notam_text).toBe('UPDATED TEXT')
    })
  })

  describe('findById', () => {
    it('should find NOTAM by ID', async () => {
      const notam = sampleNotams[0]
      await notamModel.create(notam)

      const found = await notamModel.findById(notam.notam_id)

      expect(found).not.toBeNull()
      expect(found?.notam_id).toBe(notam.notam_id)
    })

    it('should return null for non-existent NOTAM', async () => {
      const found = await notamModel.findById('NON_EXISTENT')
      expect(found).toBeNull()
    })
  })

  describe('findByFilters', () => {
    beforeEach(async () => {
      // Create all sample NOTAMs
      for (const notam of sampleNotams) {
        await notamModel.create(notam)
      }
    })

    it('should find NOTAMs by location', async () => {
      const results = await notamModel.findByFilters({ location: 'KJFK' })

      expect(results.length).toBe(1)
      expect(results[0].icao_location).toBe('KJFK')
    })

    it('should find NOTAMs by date range', async () => {
      const results = await notamModel.findByFilters({
        start: new Date('2025-01-12T00:00:00Z'),
        end: new Date('2025-01-18T00:00:00Z'),
      })

      expect(results.length).toBeGreaterThan(0)
    })

    it('should find NOTAMs by purpose', async () => {
      const results = await notamModel.findByFilters({ purpose: 'N' })

      expect(results.length).toBeGreaterThan(0)
      results.forEach((notam) => {
        expect(notam.purpose).toBe('N')
      })
    })

    it('should support pagination', async () => {
      const page1 = await notamModel.findByFilters({ limit: 2, offset: 0 })
      const page2 = await notamModel.findByFilters({ limit: 2, offset: 2 })

      expect(page1.length).toBeLessThanOrEqual(2)
      expect(page2.length).toBeLessThanOrEqual(2)

      if (page1.length > 0 && page2.length > 0) {
        expect(page1[0].id).not.toBe(page2[0].id)
      }
    })
  })

  describe('createBatch', () => {
    it('should batch upsert multiple NOTAMs in one call', async () => {
      const result = await notamModel.createBatch(sampleNotams)

      expect(result.inserted).toBe(3)
      expect(result.updated).toBe(0)

      // Verify all NOTAMs are in the database
      const count = await notamModel.count()
      expect(count).toBe(3)

      // Verify individual records
      for (const notam of sampleNotams) {
        const found = await notamModel.findById(notam.notam_id)
        expect(found).not.toBeNull()
        expect(found?.notam_text).toBe(notam.notam_text)
        expect(found?.icao_location).toBe(notam.icao_location)
      }
    })

    it('should handle empty array', async () => {
      const result = await notamModel.createBatch([])

      expect(result.inserted).toBe(0)
      expect(result.updated).toBe(0)

      const count = await notamModel.count()
      expect(count).toBe(0)
    })

    it('should handle duplicates correctly via upsert', async () => {
      // First batch insert
      const firstResult = await notamModel.createBatch(sampleNotams)
      expect(firstResult.inserted).toBe(3)
      expect(firstResult.updated).toBe(0)

      // Modify texts and batch insert again (same notam_ids)
      const updatedNotams = sampleNotams.map((n) => ({
        ...n,
        notam_text: `UPDATED: ${n.notam_text}`,
      }))
      const secondResult = await notamModel.createBatch(updatedNotams)
      expect(secondResult.inserted).toBe(0)
      expect(secondResult.updated).toBe(3)

      // Verify total count hasn't changed (no duplicate rows)
      const count = await notamModel.count()
      expect(count).toBe(3)

      // Verify updates were applied
      for (const notam of updatedNotams) {
        const found = await notamModel.findById(notam.notam_id)
        expect(found?.notam_text).toBe(notam.notam_text)
      }
    })

    it('should handle a mix of inserts and updates', async () => {
      // Insert first two NOTAMs individually
      await notamModel.create(sampleNotams[0])
      await notamModel.create(sampleNotams[1])

      // Batch insert all three -- first two will be updates, third will be insert
      const result = await notamModel.createBatch(sampleNotams)
      expect(result.inserted).toBe(1)
      expect(result.updated).toBe(2)

      const count = await notamModel.count()
      expect(count).toBe(3)
    })
  })

  describe('count', () => {
    beforeEach(async () => {
      for (const notam of sampleNotams) {
        await notamModel.create(notam)
      }
    })

    it('should count all NOTAMs', async () => {
      const count = await notamModel.count()
      expect(count).toBe(sampleNotams.length)
    })

    it('should count NOTAMs with filters', async () => {
      const count = await notamModel.count({ location: 'KJFK' })
      expect(count).toBe(1)
    })
  })
})
