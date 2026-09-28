#pragma once

#include <stdbool.h>
#include <stdint.h>

// One minute of HealthMinuteData as the watch sends it to the phone, in
// MINUTE_WIRE_SIZE bytes:
//   [0] steps
//   [1] orientation: the yaw bin in the low nibble, the pitch bin in the high
//   [2] vmc, low byte
//   [3] vmc, high byte
//   [4] flags: bit 0 set when the minute is invalid, bits 1-3 the
//       AmbientLightLevel
//   [5] heart rate in bpm, 0 for no reading
// An hour's message carries MINUTE_WIRE_HOUR_MINUTES of them, oldest first.
// Decoded by src/pkjs/minute-history.js. Kept free of pebble.h so the host
// tests build it (pebble.h's MINUTES_PER_HOUR is the same 60).
#define MINUTE_WIRE_SIZE 6
#define MINUTE_WIRE_HOUR_MINUTES 60
#define MINUTE_WIRE_HOUR_SIZE (MINUTE_WIRE_SIZE * MINUTE_WIRE_HOUR_MINUTES)

// Writes one minute's fields into out. light is an AmbientLightLevel (0-4);
// only its low 3 bits are kept.
void minute_wire_pack(
  uint8_t out[MINUTE_WIRE_SIZE],
  uint8_t steps,
  uint8_t orientation,
  uint16_t vmc,
  bool invalid,
  uint8_t light,
  uint8_t heart_rate_bpm
);
