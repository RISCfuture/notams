import { NOTAMModel, NOTAM } from '../../src/models/notam';

describe('NOTAM Pruning', () => {
  let notamModel: NOTAMModel;

  beforeEach(() => {
    notamModel = new NOTAMModel();
  });

  it('should delete NOTAMs expired more than 30 days ago', async () => {
    // Create expired NOTAM (60 days old)
    const expiredNotam: NOTAM = {
      notam_id: 'EXPIRED_60_DAYS',
      icao_location: 'KJFK',
      effective_start: new Date('2020-01-01T00:00:00Z'),
      effective_end: new Date('2020-01-15T00:00:00Z'),
      schedule: null,
      notam_text: 'EXPIRED NOTAM',
      q_line: null,
      purpose: null,
      scope: null,
      traffic_type: null,
      raw_message: null,
    };

    await notamModel.create(expiredNotam);

    // Run pruning
    const deletedCount = await notamModel.deleteExpired(30);
    expect(deletedCount).toBeGreaterThan(0);

    // Verify deleted
    const found = await notamModel.findById('EXPIRED_60_DAYS');
    expect(found).toBeNull();
  });

  it('should not delete NOTAMs expired less than 30 days ago', async () => {
    // Create recently expired NOTAM (10 days old)
    const recentDate = new Date();
    recentDate.setDate(recentDate.getDate() - 10);

    const recentlyExpiredNotam: NOTAM = {
      notam_id: 'EXPIRED_10_DAYS',
      icao_location: 'KLAX',
      effective_start: new Date('2025-01-01T00:00:00Z'),
      effective_end: recentDate,
      schedule: null,
      notam_text: 'RECENTLY EXPIRED NOTAM',
      q_line: null,
      purpose: null,
      scope: null,
      traffic_type: null,
      raw_message: null,
    };

    await notamModel.create(recentlyExpiredNotam);

    // Run pruning
    await notamModel.deleteExpired(30);

    // Verify not deleted
    const found = await notamModel.findById('EXPIRED_10_DAYS');
    expect(found).not.toBeNull();
  });

  it('should not delete active NOTAMs', async () => {
    const activeNotam: NOTAM = {
      notam_id: 'ACTIVE_NOTAM',
      icao_location: 'KORD',
      effective_start: new Date(),
      effective_end: new Date('2025-12-31T23:59:59Z'),
      schedule: null,
      notam_text: 'ACTIVE NOTAM',
      q_line: null,
      purpose: null,
      scope: null,
      traffic_type: null,
      raw_message: null,
    };

    await notamModel.create(activeNotam);

    // Run pruning
    await notamModel.deleteExpired(30);

    // Verify not deleted
    const found = await notamModel.findById('ACTIVE_NOTAM');
    expect(found).not.toBeNull();
  });

  it('should not delete NOTAMs with null expiration (PERM)', async () => {
    const permanentNotam: NOTAM = {
      notam_id: 'PERM_NOTAM',
      icao_location: 'KSEA',
      effective_start: new Date('2020-01-01T00:00:00Z'),
      effective_end: null, // PERM
      schedule: null,
      notam_text: 'PERMANENT NOTAM',
      q_line: null,
      purpose: null,
      scope: null,
      traffic_type: null,
      raw_message: null,
    };

    await notamModel.create(permanentNotam);

    // Run pruning
    await notamModel.deleteExpired(30);

    // Verify not deleted
    const found = await notamModel.findById('PERM_NOTAM');
    expect(found).not.toBeNull();
  });

  it('should return count of deleted NOTAMs', async () => {
    // Create multiple expired NOTAMs
    for (let i = 0; i < 5; i++) {
      const expiredNotam: NOTAM = {
        notam_id: `EXPIRED_${i}`,
        icao_location: 'KJFK',
        effective_start: new Date('2020-01-01T00:00:00Z'),
        effective_end: new Date('2020-01-15T00:00:00Z'),
        schedule: null,
        notam_text: `EXPIRED NOTAM ${i}`,
        q_line: null,
        purpose: null,
        scope: null,
        traffic_type: null,
        raw_message: null,
      };

      await notamModel.create(expiredNotam);
    }

    const deletedCount = await notamModel.deleteExpired(30);
    expect(deletedCount).toBe(5);
  });
});
