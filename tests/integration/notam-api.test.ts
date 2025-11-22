import request from 'supertest';
import { createServer } from '../../src/server';
import { NOTAMModel, NOTAM } from '../../src/models/notam';
import { readFileSync } from 'fs';
import { join } from 'path';

describe('NOTAM API', () => {
  const app = createServer();
  let notamModel: NOTAMModel;
  let sampleNotams: NOTAM[];

  beforeEach(async () => {
    notamModel = new NOTAMModel();

    const fixturesPath = join(__dirname, '../fixtures/sample-notams.json');
    sampleNotams = JSON.parse(readFileSync(fixturesPath, 'utf-8'));

    // Convert date strings to Date objects
    sampleNotams = sampleNotams.map((notam) => ({
      ...notam,
      effective_start: new Date(notam.effective_start),
      effective_end: notam.effective_end ? new Date(notam.effective_end) : null,
    }));

    // Insert sample NOTAMs
    for (const notam of sampleNotams) {
      await notamModel.create(notam);
    }
  });

  describe('GET /health', () => {
    it('should return 200 OK with health status', async () => {
      const response = await request(app).get('/health');

      expect(response.status).toBe(200);
      expect(response.body.status).toBe('ok');
      expect(response.body.database).toBe('connected');
    });
  });

  describe('GET /api/notams', () => {
    it('should return 401 without authentication', async () => {
      const response = await request(app).get('/api/notams');

      expect(response.status).toBe(401);
    });

    it('should return 401 with invalid token', async () => {
      const response = await request(app)
        .get('/api/notams')
        .set('Authorization', 'Bearer invalid-token');

      expect(response.status).toBe(401);
    });

    it('should return all NOTAMs with valid token', async () => {
      const response = await request(app)
        .get('/api/notams')
        .set('Authorization', 'Bearer dev-token-12345');

      expect(response.status).toBe(200);
      expect(response.body.data).toBeInstanceOf(Array);
      expect(response.body.data.length).toBe(sampleNotams.length);
      expect(response.body.pagination).toBeDefined();
      expect(response.body.pagination.total).toBe(sampleNotams.length);
    });

    it('should filter NOTAMs by location', async () => {
      const response = await request(app)
        .get('/api/notams?location=KJFK')
        .set('Authorization', 'Bearer dev-token-12345');

      expect(response.status).toBe(200);
      expect(response.body.data.length).toBe(1);
      expect(response.body.data[0].icao_location).toBe('KJFK');
    });

    it('should filter NOTAMs by date range', async () => {
      const response = await request(app)
        .get('/api/notams?start=2025-01-12T00:00:00Z&end=2025-01-18T00:00:00Z')
        .set('Authorization', 'Bearer dev-token-12345');

      expect(response.status).toBe(200);
      expect(response.body.data).toBeInstanceOf(Array);
    });

    it('should filter NOTAMs by purpose', async () => {
      const response = await request(app)
        .get('/api/notams?purpose=N')
        .set('Authorization', 'Bearer dev-token-12345');

      expect(response.status).toBe(200);
      response.body.data.forEach((notam: NOTAM) => {
        expect(notam.purpose).toBe('N');
      });
    });

    it('should filter NOTAMs by scope', async () => {
      const response = await request(app)
        .get('/api/notams?scope=A')
        .set('Authorization', 'Bearer dev-token-12345');

      expect(response.status).toBe(200);
      response.body.data.forEach((notam: NOTAM) => {
        expect(notam.scope).toBe('A');
      });
    });

    it('should support pagination', async () => {
      const response = await request(app)
        .get('/api/notams?limit=2&offset=0')
        .set('Authorization', 'Bearer dev-token-12345');

      expect(response.status).toBe(200);
      expect(response.body.data.length).toBeLessThanOrEqual(2);
      expect(response.body.pagination.limit).toBe(2);
      expect(response.body.pagination.offset).toBe(0);
    });

    it('should return 400 for invalid query parameters', async () => {
      const response = await request(app)
        .get('/api/notams?start=invalid-date')
        .set('Authorization', 'Bearer dev-token-12345');

      expect(response.status).toBe(400);
    });
  });

  describe('GET /api/notams/:notam_id', () => {
    it('should return 401 without authentication', async () => {
      const response = await request(app).get('/api/notams/' + encodeURIComponent('FDC 2/1234'));

      expect(response.status).toBe(401);
    });

    it('should return specific NOTAM', async () => {
      const response = await request(app)
        .get('/api/notams/' + encodeURIComponent('FDC 2/1234'))
        .set('Authorization', 'Bearer dev-token-12345');

      expect(response.status).toBe(200);
      expect(response.body.data.notam_id).toBe('FDC 2/1234');
    });

    it('should return 404 for non-existent NOTAM', async () => {
      const response = await request(app)
        .get('/api/notams/NON_EXISTENT')
        .set('Authorization', 'Bearer dev-token-12345');

      expect(response.status).toBe(404);
    });
  });
});
