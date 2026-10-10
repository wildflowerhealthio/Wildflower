// Host-side driver for minute-wire.c, built and run by minute-wire.test.ts.
// Reads one command per stdin line and prints one result line:
//   pack <steps> <orientation> <vmc> <invalid> <light> <heart rate>
//       ->  minute_wire_pack's bytes, space-separated decimal
//   sizes  ->  "<MINUTE_WIRE_SIZE> <MINUTE_WIRE_HOUR_MINUTES>", so the test
//              reads the layout instead of copying it
// The output buffer is malloc'd at exactly MINUTE_WIRE_SIZE, so the test's
// AddressSanitizer build fails on any write past its end.

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "../src/c/minute-wire.h"

#define MAX_LINE 256

static void prv_pack(const char *args) {
  unsigned steps = 0, orientation = 0, vmc = 0, invalid = 0, light = 0, heart_rate = 0;
  sscanf(args, "%u %u %u %u %u %u", &steps, &orientation, &vmc, &invalid, &light, &heart_rate);
  uint8_t *out = malloc(MINUTE_WIRE_SIZE);
  minute_wire_pack(
    out,
    (uint8_t)steps,
    (uint8_t)orientation,
    (uint16_t)vmc,
    invalid != 0,
    (uint8_t)light,
    (uint8_t)heart_rate
  );
  for (int i = 0; i < MINUTE_WIRE_SIZE; i++) {
    printf(i == 0 ? "%u" : " %u", out[i]);
  }
  printf("\n");
  free(out);
}

int main(void) {
  char line[MAX_LINE];
  while (fgets(line, sizeof(line), stdin) != NULL) {
    line[strcspn(line, "\n")] = '\0';
    if (strncmp(line, "pack ", 5) == 0) {
      prv_pack(line + 5);
    } else if (strcmp(line, "sizes") == 0) {
      printf("%d %d\n", MINUTE_WIRE_SIZE, MINUTE_WIRE_HOUR_MINUTES);
    } else {
      fprintf(stderr, "unknown command: %s\n", line);
      return 1;
    }
  }
  return 0;
}
