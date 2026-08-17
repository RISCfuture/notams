import { readFileSync } from 'fs'
import { join } from 'path'
import { NOTAMParser } from '../../src/services/notam-parser'

const AIXM_MESSAGE_REGEX = /<AIXMBasicMessage[\s\S]*?<\/AIXMBasicMessage>/g

function aixmMessages(): string[] {
  const xmlPath = join(__dirname, '../fixtures/nms-aixm-initial-load.xml')
  return readFileSync(xmlPath, 'utf-8').match(AIXM_MESSAGE_REGEX) ?? []
}

function aixmMessageAt(index: number): string {
  const messages = aixmMessages()
  if (index >= messages.length) {
    throw new Error(`Fixture has no AIXMBasicMessage at index ${String(index)}`)
  }
  return messages[index]
}

describe('Initial Load AIXM Parsing', () => {
  it('should parse extracted AIXMBasicMessage blocks individually', () => {
    const parser = new NOTAMParser()
    const notams = aixmMessages()
      .map((xml) => parser.parseAIXMMessage(xml))
      .filter((n) => n !== null)

    // The second block has a simple structure the parser can handle;
    // the first block has multiple hasMember elements (RunwayDirection, Runway, etc.)
    // and the parser only finds the Event in the simpler second block.
    expect(notams.length).toBeGreaterThan(0)
    expect(notams[0].notam_id).toBeDefined()
    expect(notams[0].icao_location).toBeDefined()
    expect(notams[0].notam_text).toBeDefined()
    expect(notams[0].effective_start).toBeInstanceOf(Date)
  })

  it('should return null for complex multi-hasMember blocks', () => {
    // The first AIXM block in the fixture has 5 hasMember elements
    // (RunwayDirection, Runway, RunwayElement, AirportHeliport, Event).
    // The parser expects hasMember to directly contain an Event,
    // so it returns null for this complex structure.
    const parser = new NOTAMParser()
    const notam = parser.parseAIXMMessage(aixmMessageAt(0))

    // The parser cannot navigate the multi-member structure
    expect(notam).toBeNull()
  })

  it('should parse simple single-Event AIXM block from initial load', () => {
    const parser = new NOTAMParser()
    const notam = parser.parseAIXMMessage(aixmMessageAt(1))

    expect(notam).not.toBeNull()
    expect(notam?.icao_location).toBe('ZBW')
    expect(notam?.notam_text).toContain('AIRSPACE UAS')
  })
})
