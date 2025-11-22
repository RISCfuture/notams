import { NOTAMModel, NOTAM } from '../../../src/models/notam';
import { readFileSync } from 'fs';
import { join } from 'path';

describe('NOTAMModel', () => {
  let notamModel: NOTAMModel;
  let sampleNotams: NOTAM[];

  beforeEach(() => {
    notamModel = new NOTAMModel();

    const fixturesPath = join(__dirname, '../../fixtures/sample-notams.json');
    sampleNotams = JSON.parse(readFileSync(fixturesPath, 'utf-8'));

    // Convert date strings to Date objects
    sampleNotams = sampleNotams.map((notam) => ({
      ...notam,
      effective_start: new Date(notam.effective_start),
      effective_end: notam.effective_end ? new Date(notam.effective_end) : null,
    }));
  });

  describe('create', () => {
    it('should create a new NOTAM', async () => {
      const notam = sampleNotams[0];
      const created = await notamModel.create(notam);

      expect(created.id).toBeDefined();
      expect(created.notam_id).toBe(notam.notam_id);
      expect(created.icao_location).toBe(notam.icao_location);
      expect(created.notam_text).toBe(notam.notam_text);
    });

    it('should update existing NOTAM on conflict', async () => {
      const notam = sampleNotams[0];

      // Create first time
      const created = await notamModel.create(notam);

      // Update with same notam_id
      const updated = await notamModel.create({
        ...notam,
        notam_text: 'UPDATED TEXT',
      });

      expect(updated.id).toBe(created.id);
      expect(updated.notam_text).toBe('UPDATED TEXT');
    });
  });

  describe('findById', () => {
    it('should find NOTAM by ID', async () => {
      const notam = sampleNotams[0];
      await notamModel.create(notam);

      const found = await notamModel.findById(notam.notam_id);

      expect(found).not.toBeNull();
      expect(found?.notam_id).toBe(notam.notam_id);
    });

    it('should return null for non-existent NOTAM', async () => {
      const found = await notamModel.findById('NON_EXISTENT');
      expect(found).toBeNull();
    });
  });

  describe('findByFilters', () => {
    beforeEach(async () => {
      // Create all sample NOTAMs
      for (const notam of sampleNotams) {
        await notamModel.create(notam);
      }
    });

    it('should find NOTAMs by location', async () => {
      const results = await notamModel.findByFilters({ location: 'KJFK' });

      expect(results.length).toBe(1);
      expect(results[0].icao_location).toBe('KJFK');
    });

    it('should find NOTAMs by date range', async () => {
      const results = await notamModel.findByFilters({
        start: new Date('2025-01-12T00:00:00Z'),
        end: new Date('2025-01-18T00:00:00Z'),
      });

      expect(results.length).toBeGreaterThan(0);
    });

    it('should find NOTAMs by purpose', async () => {
      const results = await notamModel.findByFilters({ purpose: 'N' });

      expect(results.length).toBeGreaterThan(0);
      results.forEach((notam) => {
        expect(notam.purpose).toBe('N');
      });
    });

    it('should find NOTAMs by scope', async () => {
      const results = await notamModel.findByFilters({ scope: 'A' });

      expect(results.length).toBeGreaterThan(0);
      results.forEach((notam) => {
        expect(notam.scope).toBe('A');
      });
    });

    it('should support pagination', async () => {
      const page1 = await notamModel.findByFilters({ limit: 2, offset: 0 });
      const page2 = await notamModel.findByFilters({ limit: 2, offset: 2 });

      expect(page1.length).toBeLessThanOrEqual(2);
      expect(page2.length).toBeLessThanOrEqual(2);

      if (page1.length > 0 && page2.length > 0) {
        expect(page1[0].id).not.toBe(page2[0].id);
      }
    });
  });

  describe('deleteExpired', () => {
    it('should delete expired NOTAMs', async () => {
      // Create NOTAM with old expiration date
      const expiredNotam: NOTAM = {
        ...sampleNotams[0],
        notam_id: 'EXPIRED_001',
        effective_end: new Date('2020-01-01T00:00:00Z'),
      };

      await notamModel.create(expiredNotam);

      const deletedCount = await notamModel.deleteExpired(30);
      expect(deletedCount).toBeGreaterThan(0);

      const found = await notamModel.findById('EXPIRED_001');
      expect(found).toBeNull();
    });

    it('should not delete active NOTAMs', async () => {
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);

      const activeNotam: NOTAM = {
        notam_id: 'ACTIVE_NOTAM',
        icao_location: 'KJFK',
        effective_start: new Date(),
        effective_end: tomorrow, // Expires tomorrow
        schedule: null,
        notam_text: 'ACTIVE TEST NOTAM',
        q_line: null,
        purpose: 'N',
        scope: 'A',
        traffic_type: 'I',
        raw_message: '<test/>',
      };

      await notamModel.create(activeNotam);
      await notamModel.deleteExpired(30);

      const found = await notamModel.findById('ACTIVE_NOTAM');
      expect(found).not.toBeNull();
    });
  });

  describe('count', () => {
    beforeEach(async () => {
      for (const notam of sampleNotams) {
        await notamModel.create(notam);
      }
    });

    it('should count all NOTAMs', async () => {
      const count = await notamModel.count();
      expect(count).toBe(sampleNotams.length);
    });

    it('should count NOTAMs with filters', async () => {
      const count = await notamModel.count({ location: 'KJFK' });
      expect(count).toBe(1);
    });
  });
});
