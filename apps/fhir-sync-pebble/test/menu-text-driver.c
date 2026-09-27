// Host-side driver for menu-text.c, built and run by menu-text.test.ts. Reads
// one command per stdin line and prints one result line:
//   time <mon> <mday> <hour> <min> <24h>       ->  menu_text_format_time
//   last-sync never|<mon> <mday> <hour> <min> <24h>
//                                              ->  menu_text_format_last_sync
//   last-auth never|<mon> <mday> <hour> <min> <24h>
//                                              ->  menu_text_format_last_auth
//   patient-title <connected> <name...>        ->  menu_text_patient_title
//   patient-subtitle <connected> <birth date>  ->  menu_text_format_patient_subtitle
//   data-type-title <data type>                ->  menu_text_data_type_title
//   sync-label ready|loading|disabled          ->  menu_text_sync_button_label
//   sizes      ->  "<DATA_TYPE_COUNT> <TIME_TEXT_SIZE> <PATIENT_SUBTITLE_SIZE>", so
//                  the test reads the limits instead of copying them
// <24h> and <connected> are 0 or 1. The text after <connected> may be empty.
// Each buffer is malloc'd at exactly the size the watch uses, so the test's
// AddressSanitizer build fails on any write or read past its end.

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "../src/c/menu-text.h"

#define MAX_LINE 1024

// Parses "<mon> <mday> <hour> <min> <24h>" into time and clock_24h.
static void prv_parse_time(const char *args, struct tm *time, bool *clock_24h) {
  int is_24h = 0;
  memset(time, 0, sizeof(*time));
  sscanf(args, "%d %d %d %d %d", &time->tm_mon, &time->tm_mday, &time->tm_hour, &time->tm_min,
         &is_24h);
  *clock_24h = is_24h != 0;
}

static void prv_time(const char *args) {
  struct tm time;
  bool clock_24h;
  prv_parse_time(args, &time, &clock_24h);
  char *text = malloc(TIME_TEXT_SIZE);
  menu_text_format_time(text, &time, clock_24h);
  printf("%s\n", text);
  free(text);
}

typedef void (*TimeLineFormatter)(char *text, const struct tm *time, bool clock_24h);

static void prv_time_line(const char *args, size_t size, TimeLineFormatter format) {
  char *text = malloc(size);
  if (strcmp(args, "never") == 0) {
    format(text, NULL, false);
  } else {
    struct tm time;
    bool clock_24h;
    prv_parse_time(args, &time, &clock_24h);
    format(text, &time, clock_24h);
  }
  printf("%s\n", text);
  free(text);
}

// Splits "<connected> <rest>" into connected and a pointer to rest, which is
// empty when nothing follows the flag.
static const char *prv_connected_and_rest(const char *args, bool *connected) {
  *connected = args[0] == '1';
  return args[1] == ' ' ? args + 2 : args + 1;
}

static void prv_patient_title(const char *args) {
  bool connected;
  const char *rest = prv_connected_and_rest(args, &connected);
  size_t length = strlen(rest);
  char *name = malloc(length + 1);
  memcpy(name, rest, length + 1);
  printf("%s\n", menu_text_patient_title(connected, name));
  free(name);
}

static void prv_patient_subtitle(const char *args) {
  bool connected;
  const char *rest = prv_connected_and_rest(args, &connected);
  size_t length = strlen(rest);
  char *birth_date = malloc(length + 1);
  memcpy(birth_date, rest, length + 1);
  char *text = malloc(PATIENT_SUBTITLE_SIZE);
  menu_text_format_patient_subtitle(text, connected, birth_date);
  printf("%s\n", text);
  free(text);
  free(birth_date);
}

int main(void) {
  char line[MAX_LINE];
  while (fgets(line, sizeof(line), stdin) != NULL) {
    line[strcspn(line, "\n")] = '\0';
    if (strncmp(line, "time ", 5) == 0) {
      prv_time(line + 5);
    } else if (strncmp(line, "last-sync ", 10) == 0) {
      prv_time_line(line + 10, LAST_SYNC_TEXT_SIZE, menu_text_format_last_sync);
    } else if (strncmp(line, "last-auth ", 10) == 0) {
      prv_time_line(line + 10, LAST_AUTH_TEXT_SIZE, menu_text_format_last_auth);
    } else if (strncmp(line, "patient-title ", 14) == 0) {
      prv_patient_title(line + 14);
    } else if (strncmp(line, "patient-subtitle ", 17) == 0) {
      prv_patient_subtitle(line + 17);
    } else if (strncmp(line, "data-type-title ", 16) == 0) {
      printf("%s\n", menu_text_data_type_title(atoi(line + 16)));
    } else if (strcmp(line, "sync-label ready") == 0) {
      printf("%s\n", menu_text_sync_button_label(SyncButtonReady));
    } else if (strcmp(line, "sync-label loading") == 0) {
      printf("%s\n", menu_text_sync_button_label(SyncButtonLoading));
    } else if (strcmp(line, "sync-label disabled") == 0) {
      printf("%s\n", menu_text_sync_button_label(SyncButtonDisabled));
    } else if (strcmp(line, "sizes") == 0) {
      printf("%d %d %d\n", DATA_TYPE_COUNT, TIME_TEXT_SIZE, PATIENT_SUBTITLE_SIZE);
    } else {
      fprintf(stderr, "unknown command: %s\n", line);
      return 1;
    }
  }
  return 0;
}
