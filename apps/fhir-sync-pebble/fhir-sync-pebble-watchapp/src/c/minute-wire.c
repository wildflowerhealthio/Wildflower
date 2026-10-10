#include "minute-wire.h"

void minute_wire_pack(
  uint8_t out[MINUTE_WIRE_SIZE],
  uint8_t steps,
  uint8_t orientation,
  uint16_t vmc,
  bool invalid,
  uint8_t light,
  uint8_t heart_rate_bpm
) {
  out[0] = steps;
  out[1] = orientation;
  out[2] = vmc & 0xFF;
  out[3] = vmc >> 8;
  out[4] = (invalid ? 1 : 0) | ((light & 0x7) << 1);
  out[5] = heart_rate_bpm;
}
