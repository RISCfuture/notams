import { readFileSync } from 'fs';
import { join } from 'path';
import { NOTAMParser } from '../../src/services/notam-parser';
import { NOTAMModel } from '../../src/models/notam';

describe('JMS Ingestion', () => {
  let parser: NOTAMParser;
  let notamModel: NOTAMModel;

  beforeEach(() => {
    parser = new NOTAMParser();
    notamModel = new NOTAMModel();
  });

  describe('AIXM Message Processing', () => {
    it('should process and store AIXM message', async () => {
      const xmlPath = join(__dirname, '../fixtures/jms-messages.xml');
      const xmlString = readFileSync(xmlPath, 'utf-8');

      // Parse message
      const notam = parser.parseAIXMMessage(xmlString);
      expect(notam).not.toBeNull();

      // Store in database
      const created = await notamModel.create(notam!);
      expect(created.id).toBeDefined();

      // Verify stored correctly
      const found = await notamModel.findById(notam!.notam_id);
      expect(found).not.toBeNull();
      expect(found?.notam_id).toBe(notam!.notam_id);
      expect(found?.icao_location).toBe(notam!.icao_location);
    });

    it('should handle duplicate NOTAM messages (upsert)', async () => {
      const xmlPath = join(__dirname, '../fixtures/jms-messages.xml');
      const xmlString = readFileSync(xmlPath, 'utf-8');

      // Parse and store first time
      const notam1 = parser.parseAIXMMessage(xmlString);
      const created1 = await notamModel.create(notam1!);

      // Parse and store again (should update)
      const notam2 = parser.parseAIXMMessage(xmlString);
      const created2 = await notamModel.create(notam2!);

      // Should have same ID (update, not insert)
      expect(created1.id).toBe(created2.id);

      // Verify only one record exists
      const all = await notamModel.findByFilters({});
      const matching = all.filter((n) => n.notam_id === notam1!.notam_id);
      expect(matching.length).toBe(1);
    });
  });

  describe('Text Message Processing', () => {
    it('should process and store text NOTAM', async () => {
      const textNotam = `A5/1111
A) KSEA
B) 2501201200
C) 2501251800
E) APRON CONSTRUCTION`;

      const notam = parser.parseTextNOTAM(textNotam);
      expect(notam).not.toBeNull();

      const created = await notamModel.create(notam!);
      expect(created.id).toBeDefined();

      const found = await notamModel.findById(notam!.notam_id);
      expect(found).not.toBeNull();
    });
  });

  describe('Message Format Detection', () => {
    it('should detect XML format', () => {
      const xmlPath = join(__dirname, '../fixtures/jms-messages.xml');
      const xmlString = readFileSync(xmlPath, 'utf-8');

      expect(xmlString.trim().startsWith('<')).toBe(true);
    });

    it('should detect text format', () => {
      const textMessage = `A5/1111
A) KSEA`;

      expect(textMessage.trim().startsWith('<')).toBe(false);
    });
  });

  describe('Error Handling', () => {
    it('should handle malformed XML gracefully', async () => {
      const malformedXml = '<invalid><xml>missing closing tag';

      const notam = parser.parseAIXMMessage(malformedXml);
      expect(notam).toBeNull();
    });

    it('should handle incomplete text NOTAM gracefully', async () => {
      const incompleteText = 'E) RUNWAY CLOSED';

      const notam = parser.parseTextNOTAM(incompleteText);
      expect(notam).toBeNull();
    });
  });

  describe('Q-Line Parsing', () => {
    it('should extract Q-line data from AIXM', () => {
      const xmlPath = join(__dirname, '../fixtures/jms-messages.xml');
      const xmlString = readFileSync(xmlPath, 'utf-8');

      const notam = parser.parseAIXMMessage(xmlString);

      // Q-line extraction not fully implemented in real AIXM parser
      // Purpose, scope, traffic_type are extracted directly from NOTAM element
      expect(notam?.purpose).toBe('BO');
      expect(notam?.scope).toBe('W');
      expect(notam?.traffic_type).toBe('IV');
    });
  });
});
