// Host-side driver for weights-wire.c, built and run by weights-wire.test.ts.
// Reads one command per stdin line and prints one result line:
//   decode <byte> <byte> ...  ->  "ok" or "rejected", then the weights
//                                 weights_wire_decode leaves in its out
//                                 array, person-major, which starts as -1s
//   sizes  ->  "<WEIGHTS_WIRE_SIZE> <PEOPLE_COUNT> <EXERCISE_COUNT>
//              <WEIGHTS_WIRE_MAX_WEIGHT> <WEIGHTS_WIRE_INBOX_SIZE>", so the
//              test reads the layout instead of copying it
// The input buffer is malloc'd at exactly the bytes given, so the test's
// AddressSanitizer build fails on any read past its end.

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "../src/c/weights-wire.h"

#define MAX_LINE 4096

static void prv_decode(char *args) {
  uint8_t parsed[MAX_LINE];
  size_t length = 0;
  for (char *token = strtok(args, " "); token != NULL; token = strtok(NULL, " ")) {
    parsed[length++] = (uint8_t)atoi(token);
  }
  uint8_t *bytes = malloc(length > 0 ? length : 1);
  memcpy(bytes, parsed, length);
  int out[PEOPLE_COUNT][EXERCISE_COUNT];
  for (int person = 0; person < PEOPLE_COUNT; person++) {
    for (int exercise = 0; exercise < EXERCISE_COUNT; exercise++) {
      out[person][exercise] = -1;
    }
  }
  printf("%s", weights_wire_decode(bytes, length, out) ? "ok" : "rejected");
  for (int person = 0; person < PEOPLE_COUNT; person++) {
    for (int exercise = 0; exercise < EXERCISE_COUNT; exercise++) {
      printf(" %d", out[person][exercise]);
    }
  }
  printf("\n");
  free(bytes);
}

int main(void) {
  char line[MAX_LINE];
  while (fgets(line, sizeof(line), stdin) != NULL) {
    line[strcspn(line, "\n")] = '\0';
    if (strcmp(line, "decode") == 0 || strncmp(line, "decode ", 7) == 0) {
      prv_decode(line + 6);
    } else if (strcmp(line, "sizes") == 0) {
      printf(
        "%d %d %d %d %d\n",
        WEIGHTS_WIRE_SIZE,
        PEOPLE_COUNT,
        EXERCISE_COUNT,
        WEIGHTS_WIRE_MAX_WEIGHT,
        WEIGHTS_WIRE_INBOX_SIZE
      );
    } else {
      fprintf(stderr, "unknown command: %s\n", line);
      return 1;
    }
  }
  return 0;
}
