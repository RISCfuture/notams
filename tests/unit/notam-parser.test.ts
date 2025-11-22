import { readFileSync } from 'fs';
import { join } from 'path';
import { NOTAMParser } from '../../src/services/notam-parser';

describe('NOTAMParser', () => {
  let parser: NOTAMParser;

  beforeEach(() => {
    parser = new NOTAMParser();
  });

  describe('parseAIXMMessage', () => {
    it('should parse valid AIXM XML message', () => {
      const xmlPath = join(__dirname, '../fixtures/jms-messages.xml');
      const xmlString = readFileSync(xmlPath, 'utf-8');

      const notam = parser.parseAIXMMessage(xmlString);

      expect(notam).not.toBeNull();
      expect(notam?.notam_id).toBe('A4146/2025');
      expect(notam?.icao_location).toBe('MUXX');
      expect(notam?.notam_text).toContain('EXER WILL TAKE PLACE');
      expect(notam?.purpose).toBe('BO');
      expect(notam?.scope).toBe('W');
      expect(notam?.traffic_type).toBe('IV');
    });

    it('should handle invalid XML', () => {
      const invalidXml = '<invalid>xml</invalid>';
      const notam = parser.parseAIXMMessage(invalidXml);
      expect(notam).toBeNull();
    });

    it('should parse dates correctly', () => {
      const xmlPath = join(__dirname, '../fixtures/jms-messages.xml');
      const xmlString = readFileSync(xmlPath, 'utf-8');

      const notam = parser.parseAIXMMessage(xmlString);

      expect(notam?.effective_start).toBeInstanceOf(Date);
      expect(notam?.effective_end).toBeInstanceOf(Date);
    });
  });

  describe('parseTextNOTAM', () => {
    it('should parse text-based NOTAM', () => {
      const textNotam = `A2/1234
A) KJFK
B) 2501151400
C) 2501202359
E) RWY 04L/22R CLSD`;

      const notam = parser.parseTextNOTAM(textNotam);

      expect(notam).not.toBeNull();
      expect(notam?.notam_id).toBe('A2/1234');
      expect(notam?.icao_location).toBe('KJFK');
      expect(notam?.notam_text).toBe('RWY 04L/22R CLSD');
    });

    it('should handle PERM expiration', () => {
      const textNotam = `A3/5678
A) KLAX
B) 2501100800
C) PERM
E) OBST CRANE 415FT MSL`;

      const notam = parser.parseTextNOTAM(textNotam);

      expect(notam).not.toBeNull();
      expect(notam?.effective_end).toBeNull();
    });

    it('should handle schedule (D field)', () => {
      const textNotam = `A4/9999
A) KORD
B) 2501050000
C) 2501152359
D) 0800-1800
E) TAXIWAY A CLSD`;

      const notam = parser.parseTextNOTAM(textNotam);

      expect(notam).not.toBeNull();
      expect(notam?.schedule).toBe('0800-1800');
    });

    it('should return null for incomplete text NOTAM', () => {
      const incompleteNotam = `E) RWY 04L/22R CLSD`;
      const notam = parser.parseTextNOTAM(incompleteNotam);
      expect(notam).toBeNull();
    });
  });
});
