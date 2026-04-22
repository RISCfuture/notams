import { readFileSync } from 'fs'
import { join } from 'path'
import { NOTAMParser } from '../../src/services/notam-parser'

describe('NOTAMParser', () => {
  let parser: NOTAMParser

  beforeEach(() => {
    parser = new NOTAMParser()
  })

  describe('parseAIXMMessage', () => {
    it('should parse valid AIXM XML message', () => {
      const xmlPath = join(__dirname, '../fixtures/jms-messages.xml')
      const xmlString = readFileSync(xmlPath, 'utf-8')

      const notam = parser.parseAIXMMessage(xmlString)

      expect(notam).not.toBeNull()
      expect(notam?.notam_id).toBe('A4146/2025')
      expect(notam?.icao_location).toBe('MUXX')
      expect(notam?.notam_text).toContain('EXER WILL TAKE PLACE')
      expect(notam?.purpose).toBe('BO')
      expect(notam?.scope).toBe('W')
      expect(notam?.traffic_type).toBe('IV')
    })

    it('should handle invalid XML', () => {
      const invalidXml = '<invalid>xml</invalid>'
      const notam = parser.parseAIXMMessage(invalidXml)
      expect(notam).toBeNull()
    })

    it('should parse dates correctly', () => {
      const xmlPath = join(__dirname, '../fixtures/jms-messages.xml')
      const xmlString = readFileSync(xmlPath, 'utf-8')

      const notam = parser.parseAIXMMessage(xmlString)

      expect(notam?.effective_start).toBeInstanceOf(Date)
      expect(notam?.effective_end).toBeInstanceOf(Date)
    })
  })

  describe('parseGeoJSONFeature', () => {
    it('should parse valid GeoJSON feature from NMS API', () => {
      const responsePath = join(__dirname, '../fixtures/nms-geojson-response.json')
      const response = JSON.parse(readFileSync(responsePath, 'utf-8'))
      const feature = response.data.geojson[0]

      const notam = parser.parseGeoJSONFeature(feature)

      expect(notam).not.toBeNull()
      expect(notam?.notam_id).toBe('08/430/2025')
      expect(notam?.icao_location).toBe('K8WC')
      expect(notam?.notam_text).toBe('RWY 20 RWY END ID LGT U/S')
      expect(notam?.purpose).toBe('BO')
      expect(notam?.scope).toBe('A')
      expect(notam?.traffic_type).toBe('IV')
    })

    it('should parse dates correctly from GeoJSON', () => {
      const responsePath = join(__dirname, '../fixtures/nms-geojson-response.json')
      const response = JSON.parse(readFileSync(responsePath, 'utf-8'))
      const feature = response.data.geojson[0]

      const notam = parser.parseGeoJSONFeature(feature)

      expect(notam?.effective_start).toBeInstanceOf(Date)
      expect(notam!.effective_start.toISOString()).toBe('2025-08-21T02:34:00.000Z')
      expect(notam?.effective_end).toBeInstanceOf(Date)
      expect(notam?.effective_end?.toISOString()).toBe('2025-10-01T23:59:00.000Z')
    })

    it('should parse schedule from GeoJSON', () => {
      const responsePath = join(__dirname, '../fixtures/nms-geojson-response.json')
      const response = JSON.parse(readFileSync(responsePath, 'utf-8'))
      const feature = response.data.geojson[1] // second feature has schedule

      const notam = parser.parseGeoJSONFeature(feature)

      expect(notam).not.toBeNull()
      expect(notam?.schedule).toBe('Daily:1100-0001~DLY 1100-0001')
      expect(notam?.icao_location).toBe('KZBW')
    })

    it('should extract Q-line data from GeoJSON', () => {
      const responsePath = join(__dirname, '../fixtures/nms-geojson-response.json')
      const response = JSON.parse(readFileSync(responsePath, 'utf-8'))
      const feature = response.data.geojson[0]

      const notam = parser.parseGeoJSONFeature(feature)

      expect(notam?.q_line).not.toBeNull()
      expect(notam?.q_line?.purpose).toBe('QMRLT')
      expect(notam?.q_line?.lower_altitude).toBe('000')
      expect(notam?.q_line?.upper_altitude).toBe('999')
      expect(notam?.q_line?.coordinates).toBe('3792N09073W')
    })

    it('should return null for non-object input', () => {
      expect(parser.parseGeoJSONFeature(null)).toBeNull()
      expect(parser.parseGeoJSONFeature('string')).toBeNull()
      expect(parser.parseGeoJSONFeature(42)).toBeNull()
    })

    it('should return null for missing coreNOTAMData', () => {
      const feature = { type: 'Feature', properties: {} }
      expect(parser.parseGeoJSONFeature(feature)).toBeNull()
    })

    it('should return null when notam object is missing inside coreNOTAMData', () => {
      const feature = {
        type: 'Feature',
        properties: {
          coreNOTAMData: {
            notamEvent: { encoding: 'ANNOTATION' },
          },
        },
      }
      expect(parser.parseGeoJSONFeature(feature)).toBeNull()
    })

    it('should fall back to location when icaoLocation is missing', () => {
      const feature = {
        type: 'Feature',
        properties: {
          coreNOTAMData: {
            notam: {
              number: '01/100',
              year: '2025',
              location: 'JFK',
              effectiveStart: '2025-06-01T00:00:00.000Z',
              text: 'RWY CLOSED',
            },
          },
        },
      }
      const notam = parser.parseGeoJSONFeature(feature)
      expect(notam).not.toBeNull()
      expect(notam?.icao_location).toBe('JFK')
    })

    it('should handle missing effectiveEnd gracefully', () => {
      const feature = {
        type: 'Feature',
        properties: {
          coreNOTAMData: {
            notam: {
              number: '01/200',
              year: '2025',
              icaoLocation: 'KJFK',
              effectiveStart: '2025-06-01T00:00:00.000Z',
              text: 'PERM NOTAM',
            },
          },
        },
      }
      const notam = parser.parseGeoJSONFeature(feature)
      expect(notam).not.toBeNull()
      expect(notam?.effective_end).toBeNull()
    })

    it('should handle schedule being absent', () => {
      const feature = {
        type: 'Feature',
        properties: {
          coreNOTAMData: {
            notam: {
              number: '01/400',
              year: '2025',
              icaoLocation: 'KJFK',
              effectiveStart: '2025-06-01T00:00:00.000Z',
              text: 'NO SCHEDULE',
            },
          },
        },
      }
      const notam = parser.parseGeoJSONFeature(feature)
      expect(notam).not.toBeNull()
      expect(notam?.schedule).toBeNull()
    })

    it('should handle PERM as effectiveEnd', () => {
      const feature = {
        type: 'Feature',
        properties: {
          coreNOTAMData: {
            notam: {
              number: '01/500',
              year: '2025',
              icaoLocation: 'KJFK',
              effectiveStart: '2025-06-01T00:00:00.000Z',
              effectiveEnd: 'PERM',
              text: 'PERMANENT NOTAM',
            },
          },
        },
      }
      const notam = parser.parseGeoJSONFeature(feature)
      expect(notam).not.toBeNull()
      expect(notam?.effective_end).toBeNull()
    })

    it('should return null for missing properties', () => {
      const feature = { type: 'Feature' }
      expect(parser.parseGeoJSONFeature(feature)).toBeNull()
    })

    it('should default icaoLocation to ZZZZ when both icaoLocation and location are missing', () => {
      const feature = {
        type: 'Feature',
        properties: {
          coreNOTAMData: {
            notam: {
              number: '01/600',
              year: '2025',
              effectiveStart: '2025-06-01T00:00:00.000Z',
              text: 'NO LOCATION',
            },
          },
        },
      }
      const notam = parser.parseGeoJSONFeature(feature)
      expect(notam).not.toBeNull()
      expect(notam?.icao_location).toBe('ZZZZ')
    })

    it('should set notam_id to UNKNOWN when number or year is missing', () => {
      const feature = {
        type: 'Feature',
        properties: {
          coreNOTAMData: {
            notam: {
              icaoLocation: 'KJFK',
              effectiveStart: '2025-06-01T00:00:00.000Z',
              text: 'MISSING ID FIELDS',
            },
          },
        },
      }
      const notam = parser.parseGeoJSONFeature(feature)
      expect(notam).not.toBeNull()
      expect(notam?.notam_id).toBe('UNKNOWN')
    })

    it('should return null q_line when no q-line fields are present', () => {
      const feature = {
        type: 'Feature',
        properties: {
          coreNOTAMData: {
            notam: {
              number: '01/700',
              year: '2025',
              icaoLocation: 'KJFK',
              effectiveStart: '2025-06-01T00:00:00.000Z',
              text: 'NO Q LINE',
            },
          },
        },
      }
      const notam = parser.parseGeoJSONFeature(feature)
      expect(notam).not.toBeNull()
      expect(notam?.q_line).toBeNull()
    })
  })
})
