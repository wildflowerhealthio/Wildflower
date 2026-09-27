// Host-side driver for reps-text.c, built and run by reps-text.test.ts. Reads
// one command per stdin line and prints one result line:
//   reps <n> <n> ...   ->  reps_text_format_reps over those counts
//   weight <n>         ->  reps_text_format_weight
//   sizes              ->  "<MAX_SETS> <REPS_TEXT_SIZE>", so the test reads
//                          the limits instead of copying them
// Each buffer is malloc'd at exactly the size the watch uses, so the test's
// AddressSanitizer build fails on any write or read past its end.

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "../src/c/windows/exercise-detail-window/reps-text.h"

#define MAX_LINE 1024

static void prv_reps(char *args) {
  int parsed[MAX_LINE];
  int count = 0;
  for (char *token = strtok(args, " "); token != NULL; token = strtok(NULL, " ")) {
    parsed[count++] = atoi(token);
  }
  int *reps = malloc(sizeof(int) * (count > 0 ? count : 1));
  memcpy(reps, parsed, sizeof(int) * count);
  char *text = malloc(REPS_TEXT_SIZE);
  reps_text_format_reps(text, reps, count);
  printf("%s\n", text);
  free(text);
  free(reps);
}

static void prv_weight(const char *args) {
  char *text = malloc(WEIGHT_TEXT_SIZE);
  reps_text_format_weight(text, atoi(args));
  printf("%s\n", text);
  free(text);
}

int main(void) {
  char line[MAX_LINE];
  while (fgets(line, sizeof(line), stdin) != NULL) {
    line[strcspn(line, "\n")] = '\0';
    if (strncmp(line, "reps", 4) == 0) {
      prv_reps(line + 4);
    } else if (strcmp(line, "sizes") == 0) {
      printf("%d %d\n", MAX_SETS, REPS_TEXT_SIZE);
    } else if (strncmp(line, "weight ", 7) == 0) {
      prv_weight(line + 7);
    } else {
      fprintf(stderr, "unknown command: %s\n", line);
      return 1;
    }
  }
  return 0;
}
