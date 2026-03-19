import { XMLParser } from 'fast-xml-parser'
import type { NOTAM, QLine } from '../models/notam'
import { logger } from '../config/logger'
import { notamParseErrorsTotal } from '../config/metrics'

// Type for parsed XML data (dynamic structure from XML parser)
type ParsedXMLData = Record<string, unknown>

/** Type guard for checking if a value is a non-null object */
function isRecord(value: unknown): value is ParsedXMLData {
  return typeof value === 'object' && value !== null
}

/** Safely access a property from a parsed XML object */
function prop(obj: ParsedXMLData, key: string): unknown {
  return obj[key]
}

/** Safely convert an unknown value to string, avoiding [object Object] */
function toStr(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return JSON.stringify(value)
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  parseAttributeValue: true,
})

export class NOTAMParser {
  /**
   * Parse AIXM XML message from FAA SWIM JMS
   * This is a best-guess implementation based on AIXM 5.1 spec
   */
  parseAIXMMessage(xmlString: string): NOTAM | null {
    try {
      const parsed = parser.parse(xmlString) as ParsedXMLData

      // Navigate the AIXM structure (guessed based on AIXM 5.1)
      const message = prop(parsed, 'AIXMBasicMessage') ?? prop(parsed, 'aixm:AIXMBasicMessage')
      if (!isRecord(message)) {
        notamParseErrorsTotal.inc({ format: 'aixm', error_type: 'missing_message' })
        logger.warn('No AIXMBasicMessage found in XML')
        return null
      }

      const member = prop(message, 'hasMember') ?? prop(message, 'aixm:hasMember')
      if (!isRecord(member)) {
        notamParseErrorsTotal.inc({ format: 'aixm', error_type: 'missing_member' })
        logger.warn('No hasMember found in AIXM message')
        return null
      }

      const event =
        prop(member, 'Event') ?? prop(member, 'event:Event') ?? prop(member, 'aixm:Event')
      if (!isRecord(event)) {
        notamParseErrorsTotal.inc({ format: 'aixm', error_type: 'missing_event' })
        logger.warn('No Event found in AIXM message')
        return null
      }

      const timeSlice =
        prop(event, 'timeSlice') ?? prop(event, 'event:timeSlice') ?? prop(event, 'aixm:timeSlice')
      if (!isRecord(timeSlice)) {
        notamParseErrorsTotal.inc({ format: 'aixm', error_type: 'missing_timeslice' })
        logger.warn('No timeSlice found in Event')
        return null
      }

      const eventTimeSlice =
        prop(timeSlice, 'EventTimeSlice') ??
        prop(timeSlice, 'event:EventTimeSlice') ??
        prop(timeSlice, 'aixm:EventTimeSlice')
      if (!isRecord(eventTimeSlice)) {
        notamParseErrorsTotal.inc({ format: 'aixm', error_type: 'missing_eventtimeslice' })
        logger.warn('No EventTimeSlice found')
        return null
      }

      // Navigate to textNOTAM and then NOTAM
      const textNOTAM = prop(eventTimeSlice, 'textNOTAM') ?? prop(eventTimeSlice, 'event:textNOTAM')
      const notamFromText = isRecord(textNOTAM)
        ? (prop(textNOTAM, 'NOTAM') ?? prop(textNOTAM, 'event:NOTAM'))
        : undefined

      const etsNotam = prop(eventTimeSlice, 'NOTAM')
      const etsEventNotam = prop(eventTimeSlice, 'event:NOTAM')
      const notamData = isRecord(notamFromText)
        ? notamFromText
        : isRecord(etsNotam)
          ? etsNotam
          : isRecord(etsEventNotam)
            ? etsEventNotam
            : eventTimeSlice

      return this.extractNOTAMFromData(notamData, eventTimeSlice, xmlString)
    } catch (error) {
      notamParseErrorsTotal.inc({ format: 'aixm', error_type: 'xml_exception' })
      logger.error({ error, xmlString }, 'Failed to parse AIXM XML')
      return null
    }
  }

  /**
   * Extract NOTAM fields from parsed data structure
   */
  private extractNOTAMFromData(
    data: ParsedXMLData,
    eventTimeSlice: ParsedXMLData,
    rawXml: string,
  ): NOTAM {
    // Build NOTAM ID from series, number, year
    const series = this.extractField(data, ['series', 'event:series']) ?? ''
    const number = this.extractField(data, ['number', 'event:number']) ?? ''
    const year = this.extractField(data, ['year', 'event:year']) ?? ''
    const notamId = series && number && year ? `${series}${number}/${year}` : 'UNKNOWN'

    // Extract dates - try event:effectiveStart/End first, then fall back to gml:validTime
    let effectiveStart = this.parseDate(
      this.extractField(data, ['effectiveStart', 'event:effectiveStart', 'validityStart']),
    )
    let effectiveEnd = this.parseDate(
      this.extractField(data, ['effectiveEnd', 'event:effectiveEnd', 'validityEnd']),
    )

    // If dates not found in NOTAM element, try gml:validTime from EventTimeSlice
    if (!effectiveStart || !effectiveEnd) {
      const validTime = prop(eventTimeSlice, 'gml:validTime') ?? prop(eventTimeSlice, 'validTime')
      if (isRecord(validTime)) {
        const timePeriod = prop(validTime, 'gml:TimePeriod') ?? prop(validTime, 'TimePeriod')
        if (isRecord(timePeriod)) {
          const beginPos =
            prop(timePeriod, 'gml:beginPosition') ?? prop(timePeriod, 'beginPosition')
          const endPos = prop(timePeriod, 'gml:endPosition') ?? prop(timePeriod, 'endPosition')

          if (beginPos && !effectiveStart) {
            effectiveStart = this.parseDate(toStr(beginPos))
          }
          if (endPos && !effectiveEnd) {
            effectiveEnd = this.parseDate(toStr(endPos))
          }
        }
      }
    }

    return {
      notam_id: notamId,
      icao_location:
        this.extractField(data, ['location', 'event:location', 'icaoLocation']) ?? 'ZZZZ',
      effective_start: effectiveStart ?? new Date(),
      effective_end: effectiveEnd,
      schedule: null,
      notam_text: this.extractField(data, ['text', 'event:text', 'notamText', 'itemE']) ?? '',
      q_line: this.extractQLine(data),
      purpose: this.extractField(data, ['purpose', 'event:purpose']) ?? null,
      scope: this.extractField(data, ['scope', 'event:scope']) ?? null,
      traffic_type: this.extractField(data, ['traffic', 'event:traffic']) ?? null,
      raw_message: rawXml,
    }
  }

  /**
   * Extract Q-line data from NOTAM
   */
  private extractQLine(data: ParsedXMLData): QLine | null {
    const qLineData = prop(data, 'qLine') ?? prop(data, 'QLine') ?? prop(data, 'aixm:qLine')

    if (!isRecord(qLineData)) {
      return null
    }

    return {
      purpose: this.extractField(qLineData, ['purpose', 'Purpose']),
      scope: this.extractField(qLineData, ['scope', 'Scope']),
      traffic_type: this.extractField(qLineData, ['trafficType', 'TrafficType']),
      lower_altitude: this.extractField(qLineData, ['lowerAltitude', 'LowerLimit']),
      upper_altitude: this.extractField(qLineData, ['upperAltitude', 'UpperLimit']),
      coordinates: this.extractField(qLineData, ['coordinates', 'Coordinates']),
    }
  }

  /**
   * Extract field from data using multiple possible field names
   */
  private extractField(data: ParsedXMLData, fieldNames: string[]): string | undefined {
    for (const fieldName of fieldNames) {
      if (fieldName.includes('.')) {
        // Handle nested fields like 'qLine.purpose'
        const parts = fieldName.split('.')
        let value: unknown = data
        for (const part of parts) {
          if (isRecord(value)) {
            value = prop(value, part)
          } else {
            value = undefined
            break
          }
        }
        if (value !== undefined && value !== null) return toStr(value)
      } else if (fieldName.includes(':')) {
        // Already has namespace prefix, use as-is
        const value = prop(data, fieldName)
        if (value !== undefined && value !== null) {
          return toStr(value)
        }
      } else {
        // Try with various namespace prefixes
        const value =
          prop(data, fieldName) ??
          prop(data, `aixm:${fieldName}`) ??
          prop(data, `event:${fieldName}`)
        if (value !== undefined && value !== null) {
          return toStr(value)
        }
      }
    }
    return undefined
  }

  /**
   * Parse date string to Date object
   * Supports multiple date formats
   */
  private parseDate(dateStr: string | undefined): Date | null {
    if (!dateStr) return null

    // Handle "PERM" (permanent)
    if (dateStr.toUpperCase() === 'PERM' || dateStr.toUpperCase() === 'PERMANENT') {
      return null
    }

    try {
      // Try ISO 8601 format first
      const date = new Date(dateStr)
      if (!isNaN(date.getTime())) {
        return date
      }

      // Try NOTAM format: YYMMDDhhmm (10 digits) or YYYYMMDDhhmm (12 digits)
      if (/^\d{12}$/.test(dateStr)) {
        // Format: YYYYMMDDhhmm
        const year = parseInt(dateStr.substring(0, 4), 10)
        const month = parseInt(dateStr.substring(4, 6), 10) - 1
        const day = parseInt(dateStr.substring(6, 8), 10)
        const hour = parseInt(dateStr.substring(8, 10), 10)
        const minute = parseInt(dateStr.substring(10, 12), 10)
        return new Date(Date.UTC(year, month, day, hour, minute))
      } else if (/^\d{10}$/.test(dateStr)) {
        // Format: YYMMDDhhmm
        const year = 2000 + parseInt(dateStr.substring(0, 2), 10)
        const month = parseInt(dateStr.substring(2, 4), 10) - 1
        const day = parseInt(dateStr.substring(4, 6), 10)
        const hour = parseInt(dateStr.substring(6, 8), 10)
        const minute = parseInt(dateStr.substring(8, 10), 10)
        return new Date(Date.UTC(year, month, day, hour, minute))
      }

      logger.warn({ dateStr }, 'Unable to parse date')
      return null
    } catch (error) {
      logger.error({ error, dateStr }, 'Error parsing date')
      return null
    }
  }

  /**
   * Parse legacy text-based NOTAM format (fallback)
   */
  parseTextNOTAM(text: string): NOTAM | null {
    try {
      const lines = text
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.length > 0)

      const notam: Partial<NOTAM> = {
        raw_message: text,
        notam_text: text,
      }

      for (const line of lines) {
        // A) Location
        if (line.startsWith('A)')) {
          notam.icao_location = line.substring(2).trim().substring(0, 10)
        }
        // B) Effective start
        else if (line.startsWith('B)')) {
          notam.effective_start = this.parseDate(line.substring(2).trim()) ?? new Date()
        }
        // C) Effective end
        else if (line.startsWith('C)')) {
          notam.effective_end = this.parseDate(line.substring(2).trim())
        }
        // D) Schedule
        else if (line.startsWith('D)')) {
          notam.schedule = line.substring(2).trim()
        }
        // E) NOTAM text
        else if (line.startsWith('E)')) {
          notam.notam_text = line.substring(2).trim()
        }
        // Extract NOTAM ID from first line or header
        else if (!notam.notam_id && /^[A-Z]\d+\/\d+/.test(line)) {
          notam.notam_id = line.split(/\s+/)[0]
        }
      }

      if (!notam.notam_id || !notam.icao_location || !notam.effective_start) {
        notamParseErrorsTotal.inc({ format: 'text', error_type: 'missing_fields' })
        logger.warn('Incomplete text NOTAM, missing required fields')
        return null
      }

      return notam as NOTAM
    } catch (error) {
      notamParseErrorsTotal.inc({ format: 'text', error_type: 'parse_exception' })
      logger.error({ error, text }, 'Failed to parse text NOTAM')
      return null
    }
  }
}
