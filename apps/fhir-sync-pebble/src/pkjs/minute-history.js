// Minute history sync: the watch's hour messages in, one Observation per minute
// type per hour out, each minute a sample of its valueSampledData. Kept free of
// the Pebble globals so test/minute-history.test.ts can load it under Node.
// Written as ES5 CommonJS, which every PebbleKit JS runtime accepts.

var healthActivity = require('./health-activity')

var SECONDS_PER_HOUR = 3600
var MILLISECONDS_PER_MINUTE = 60000

/** Minutes per hour message, and the bytes each takes (src/c/minute-wire.h). */
var MINUTES_PER_HOUR = 60
var MINUTE_WIRE_SIZE = 6

var LOINC = 'http://loinc.org'
var UCUM = 'http://unitsofmeasure.org'
var HEALTH_SERVICE_SYSTEM = healthActivity.HEALTH_SERVICE_SYSTEM

var VITAL_SIGNS_CATEGORY_CODING = {
  system: 'http://terminology.hl7.org/CodeSystem/observation-category',
  code: 'vital-signs',
  display: 'Vital Signs',
}

/**
 * The minute types by their bit in `MinuteTypes`, which is their `DataType`
 * value in src/c/data-type.h. Bit 0, Health Activity, isn't a minute type.
 *
 * @type {Readonly<Record<number, import('./minute-history.js').MinuteDataType>>}
 */
var MINUTE_DATA_TYPES = {
  1: 'heartRate',
  2: 'steps',
  3: 'orientation',
  4: 'movement',
  5: 'ambientLight',
}

/** Bits 1 to 5: every minute type. */
var MINUTE_TYPE_BITS = 0x3e

/**
 * Approximate lux for each `AmbientLightLevel` above Unknown: the midpoint of
 * its band on the Pebble Time 2, whose firmware splits levels at 700, 800 and
 * 900 lux (dark threshold 800 ± 100). The outer bands are open-ended.
 *
 * @type {Readonly<Record<number, number>>}
 */
var LIGHT_LEVEL_LUX = { 1: 650, 2: 750, 3: 850, 4: 950 }

/** Degrees per orientation bin: 16 bins around the full circle. */
var DEGREES_PER_ORIENTATION_BIN = 22.5

/**
 * The Observation each minute type becomes, except orientation's two angles.
 *
 * @type {Readonly<Record<string, import('./minute-history.js').SampledType>>}
 */
var SAMPLED_TYPES = {
  heartRate: {
    category: VITAL_SIGNS_CATEGORY_CODING,
    code: { coding: [{ system: LOINC, code: '8867-4', display: 'Heart rate' }] },
    unit: { unit: 'beats/minute', code: '/min' },
    // 0 bpm is the watch's "no reading".
    sample: function (minute) {
      return minute.heartRateBpm === 0 ? null : minute.heartRateBpm
    },
  },
  steps: {
    category: healthActivity.ACTIVITY_CATEGORY_CODING,
    code: {
      coding: [
        {
          system: LOINC,
          code: '55423-8',
          display: 'Number of steps in unspecified time Pedometer',
        },
      ],
    },
    unit: { unit: 'steps', code: '{steps}' },
    sample: function (minute) {
      return minute.steps
    },
  },
  movement: {
    category: healthActivity.ACTIVITY_CATEGORY_CODING,
    code: {
      coding: [
        {
          system: HEALTH_SERVICE_SYSTEM,
          code: 'HealthMinuteData.vmc',
          display: 'Pebble vector magnitude counts',
        },
      ],
    },
    unit: { unit: 'counts/minute', code: '{counts}/min' },
    sample: function (minute) {
      return minute.vmc
    },
  },
  ambientLight: {
    category: null,
    code: {
      coding: [
        {
          system: HEALTH_SERVICE_SYSTEM,
          code: 'HealthMinuteData.light',
          display: 'Pebble ambient light level',
        },
      ],
      text:
        'Pebble ambient light level as the midpoint of its lux band: 650 (very dark, under ' +
        '700 lx), 750 (dark), 850 (light) or 950 (very light, 900 lx and over)',
    },
    unit: { unit: 'lux', code: 'lx' },
    sample: function (minute) {
      return Object.prototype.hasOwnProperty.call(LIGHT_LEVEL_LUX, minute.light)
        ? LIGHT_LEVEL_LUX[minute.light]
        : null
    },
  },
}

var ORIENTATION_CODE = {
  coding: [
    {
      system: HEALTH_SERVICE_SYSTEM,
      code: 'HealthMinuteData.orientation',
      display: 'Pebble watch orientation',
    },
  ],
}

var DEGREES = { unit: 'degrees', code: 'deg' }

/**
 * Decodes one hour of minute history from the watch: `MinuteHourStart` (Unix
 * seconds on the hour), `MinuteTypes` (the minute types to post, one bit per
 * `DataType`) and `MinuteData` (60 minutes of 6 bytes, laid out in
 * src/c/minute-wire.h). Throws when the message is not that shape.
 *
 * @param {object} payload - the AppMessage payload, keyed by message key name
 * @returns {import('./minute-history.js').MinuteHour}
 */
function decodeMinuteHourMessage(payload) {
  var hourStartSeconds = healthActivity.requireInteger(payload, 'MinuteHourStart')
  if (hourStartSeconds % SECONDS_PER_HOUR !== 0) {
    throw new Error('Message field MinuteHourStart must be on the hour')
  }

  var typeBits = healthActivity.requireInteger(payload, 'MinuteTypes')
  if (typeBits <= 0 || typeBits > MINUTE_TYPE_BITS || (typeBits & ~MINUTE_TYPE_BITS) !== 0) {
    throw new Error('Message field MinuteTypes must set only minute type bits, at least one')
  }
  /** @type {Array<import('./minute-history.js').MinuteDataType>} */
  var dataTypes = []
  for (var bit = 1; bit <= 5; bit++) {
    if ((typeBits & (1 << bit)) !== 0) {
      dataTypes.push(MINUTE_DATA_TYPES[bit])
    }
  }

  /** @type {unknown} */
  var minuteData = payload.MinuteData
  if (!Array.isArray(minuteData) || minuteData.length !== MINUTES_PER_HOUR * MINUTE_WIRE_SIZE) {
    throw new Error(
      'Message field MinuteData must be ' + MINUTES_PER_HOUR * MINUTE_WIRE_SIZE + ' bytes'
    )
  }
  /** @type {Array<number>} */
  var bytes = []
  for (var index = 0; index < minuteData.length; index++) {
    /** @type {unknown} */
    var byte = minuteData[index]
    if (typeof byte !== 'number' || byte % 1 !== 0 || byte < 0 || byte > 255) {
      throw new Error('Message field MinuteData must hold bytes')
    }
    bytes.push(byte)
  }

  /** @type {Array<import('./minute-history.js').Minute | null>} */
  var minutes = []
  for (var minute = 0; minute < MINUTES_PER_HOUR; minute++) {
    var offset = minute * MINUTE_WIRE_SIZE
    var flags = bytes[offset + 4]
    if ((flags & 1) !== 0) {
      minutes.push(null)
      continue
    }
    var orientation = bytes[offset + 1]
    minutes.push({
      steps: bytes[offset],
      yawBin: orientation & 0xf,
      pitchBin: orientation >> 4,
      vmc: bytes[offset + 2] | (bytes[offset + 3] << 8),
      light: (flags >> 1) & 0x7,
      heartRateBpm: bytes[offset + 5],
    })
  }
  return { hourStartSeconds: hourStartSeconds, dataTypes: dataTypes, minutes: minutes }
}

/**
 * Decodes how many hour messages the watch sent this sync, from the message
 * ending it.
 *
 * @param {object} payload - the AppMessage payload, keyed by message key name
 * @returns {number}
 */
function decodeMinuteHourCount(payload) {
  var count = healthActivity.requireInteger(payload, 'MinuteHourCount')
  if (count < 0) {
    throw new Error('Message field MinuteHourCount must not be negative')
  }
  return count
}

/**
 * One sample per minute, in `unit`, each sample times `factor`; `E` where a
 * minute has none.
 *
 * @param {ReadonlyArray<number | null>} samples
 * @param {import('./minute-history.js').Unit} unit
 * @param {number} factor
 * @returns {import('./minute-history.js').SampledData}
 */
function toSampledData(samples, unit, factor) {
  return {
    origin: { value: 0, unit: unit.unit, system: UCUM, code: unit.code },
    period: MILLISECONDS_PER_MINUTE,
    factor: factor,
    dimensions: 1,
    data: samples
      .map(function (sample) {
        return sample === null ? 'E' : String(sample)
      })
      .join(' '),
  }
}

/**
 * @param {ReadonlyArray<number | null>} samples
 * @returns {boolean}
 */
function hasAnySample(samples) {
  return samples.some(function (sample) {
    return sample !== null
  })
}

/**
 * @param {ReadonlyArray<import('./minute-history.js').Minute | null>} minutes
 * @param {(minute: import('./minute-history.js').Minute) => number | null} sample
 * @returns {Array<number | null>}
 */
function samplesOf(minutes, sample) {
  return minutes.map(function (minute) {
    return minute === null ? null : sample(minute)
  })
}

/**
 * The Observations for one hour: one per minute type the watch asked for,
 * except a type with no sample that hour, which gets none.
 *
 * @param {import('./minute-history.js').MinuteHour} hour
 * @param {string} patientId
 * @param {string} watchDisplay - `describeWatch`'s text
 * @returns {Array<import('./minute-history.js').MinuteObservation>}
 */
function toObservations(hour, patientId, watchDisplay) {
  /**
   * @param {import('./health-activity.js').Coding | null} category
   * @param {import('./minute-history.js').MinuteObservation['code']} code
   */
  function observationOf(category, code) {
    /** @type {import('./minute-history.js').MinuteObservation} */
    var observation = {
      resourceType: 'Observation',
      status: 'final',
      code: code,
      subject: { reference: 'Patient/' + patientId },
      effectivePeriod: {
        start: healthActivity.toDateTime(hour.hourStartSeconds),
        end: healthActivity.toDateTime(hour.hourStartSeconds + SECONDS_PER_HOUR),
      },
      device: { display: watchDisplay },
    }
    if (category !== null) {
      observation.category = [{ coding: [category] }]
    }
    return observation
  }

  /** @type {Array<import('./minute-history.js').MinuteObservation>} */
  var observations = []
  hour.dataTypes.forEach(function (dataType) {
    if (dataType === 'orientation') {
      var yaw = samplesOf(hour.minutes, function (minute) {
        return minute.yawBin
      })
      var pitch = samplesOf(hour.minutes, function (minute) {
        return minute.pitchBin
      })
      if (!hasAnySample(yaw)) {
        return
      }
      var orientation = observationOf(healthActivity.ACTIVITY_CATEGORY_CODING, ORIENTATION_CODE)
      orientation.component = [
        {
          code: {
            coding: [
              {
                system: HEALTH_SERVICE_SYSTEM,
                code: 'HealthMinuteData.orientation.yaw',
                display: 'Yaw',
              },
            ],
          },
          valueSampledData: toSampledData(yaw, DEGREES, DEGREES_PER_ORIENTATION_BIN),
        },
        {
          code: {
            coding: [
              {
                system: HEALTH_SERVICE_SYSTEM,
                code: 'HealthMinuteData.orientation.pitch',
                display: 'Pitch',
              },
            ],
          },
          valueSampledData: toSampledData(pitch, DEGREES, DEGREES_PER_ORIENTATION_BIN),
        },
      ]
      observations.push(orientation)
      return
    }
    var sampledType = SAMPLED_TYPES[dataType]
    var samples = samplesOf(hour.minutes, sampledType.sample)
    if (!hasAnySample(samples)) {
      return
    }
    var observation = observationOf(sampledType.category, sampledType.code)
    observation.valueSampledData = toSampledData(samples, sampledType.unit, 1)
    observations.push(observation)
  })
  return observations
}

module.exports = {
  decodeMinuteHourCount: decodeMinuteHourCount,
  decodeMinuteHourMessage: decodeMinuteHourMessage,
  toObservations: toObservations,
}
