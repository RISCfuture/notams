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
  parseAIXMMessage(xmlString: string): NOTAM | null {
    try {
      const parsed = parser.parse(xmlString) as ParsedXMLData

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

  private extractNOTAMFromData(
    data: ParsedXMLData,
    eventTimeSlice: ParsedXMLData,
    rawXml: string,
  ): NOTAM {
    const series = this.extractField(data, ['series', 'event:series']) ?? ''
    const number = this.extractField(data, ['number', 'event:number']) ?? ''
    const year = this.extractField(data, ['year', 'event:year']) ?? ''
    const notamId = series && number && year ? `${series}${number}/${year}` : 'UNKNOWN'

    let effectiveStart = this.parseDate(
      this.extractField(data, ['effectiveStart', 'event:effectiveStart', 'validityStart']),
    )
    let effectiveEnd = this.parseDate(
      this.extractField(data, ['effectiveEnd', 'event:effectiveEnd', 'validityEnd']),
    )

    // NOTAM element may omit dates; fall back to gml:validTime on EventTimeSlice.
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

  private extractField(data: ParsedXMLData, fieldNames: string[]): string | undefined {
    for (const fieldName of fieldNames) {
      if (fieldName.includes('.')) {
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
        const value = prop(data, fieldName)
        if (value !== undefined && value !== null) {
          return toStr(value)
        }
      } else {
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

  private parseDate(dateStr: string | undefined): Date | null {
    if (!dateStr) return null

    // Handle "PERM" (permanent)
    if (dateStr.toUpperCase() === 'PERM' || dateStr.toUpperCase() === 'PERMANENT') {
      return null
    }

    try {
      const date = new Date(dateStr)
      if (!isNaN(date.getTime())) {
        return date
      }

      // NOTAM short date formats: YYYYMMDDhhmm or YYMMDDhhmm.
      if (/^\d{12}$/.test(dateStr)) {
        const year = parseInt(dateStr.substring(0, 4), 10)
        const month = parseInt(dateStr.substring(4, 6), 10) - 1
        const day = parseInt(dateStr.substring(6, 8), 10)
        const hour = parseInt(dateStr.substring(8, 10), 10)
        const minute = parseInt(dateStr.substring(10, 12), 10)
        return new Date(Date.UTC(year, month, day, hour, minute))
      } else if (/^\d{10}$/.test(dateStr)) {
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

  /** Expects feature.properties.coreNOTAMData.notam structure from NMS GeoJSON responses. */
  parseGeoJSONFeature(feature: unknown): NOTAM | null {
    try {
      if (!isRecord(feature)) return null

      const properties = prop(feature, 'properties')
      if (!isRecord(properties)) {
        notamParseErrorsTotal.inc({ format: 'geojson', error_type: 'missing_properties' })
        return null
      }

      const coreData = prop(properties, 'coreNOTAMData')
      if (!isRecord(coreData)) {
        notamParseErrorsTotal.inc({ format: 'geojson', error_type: 'missing_coreNOTAMData' })
        return null
      }

      const notamData = prop(coreData, 'notam')
      if (!isRecord(notamData)) {
        notamParseErrorsTotal.inc({ format: 'geojson', error_type: 'missing_notam' })
        return null
      }

      const str = (key: string) => toStr(prop(notamData, key) ?? '')

      const number = str('number')
      const year = str('year')
      const notamId = number && year ? `${number}/${year}` : 'UNKNOWN'

      const qLine: QLine = {
        purpose: str('selectionCode'),
        scope: str('scope'),
        traffic_type: str('traffic'),
        lower_altitude: str('minimumFl'),
        upper_altitude: str('maximumFl'),
        coordinates: str('coordinates'),
      }

      const hasQLine = Object.values(qLine).some((v) => v !== '')

      return {
        notam_id: notamId,
        icao_location: toStr(
          prop(notamData, 'icaoLocation') ?? prop(notamData, 'location') ?? 'ZZZZ',
        ),
        effective_start: this.parseDate(str('effectiveStart')) ?? new Date(),
        effective_end: this.parseDate(str('effectiveEnd')),
        schedule: str('schedule') || null,
        notam_text: str('text'),
        q_line: hasQLine ? qLine : null,
        purpose: str('purpose') || null,
        scope: str('scope') || null,
        traffic_type: str('traffic') || null,
        raw_message: JSON.stringify(feature),
      }
    } catch (error) {
      notamParseErrorsTotal.inc({ format: 'geojson', error_type: 'parse_exception' })
      logger.error({ error }, 'Failed to parse GeoJSON NOTAM feature')
      return null
    }
  }
}
