#pragma once

#include <stdbool.h>

// The SDK's libc declares no struct tm; pebble.h does. Everything else here
// stays off pebble.h, so the host build uses the standard header.
#ifdef PBL_SDK_3
#include <pebble.h>
#else
#include <time.h>
#endif

#include "data-type.h"

// The text behind the settings menu's rows, built on the host by
// test/menu-text.test.ts as well as for the watch. Times are written
// without the watch's locale: "Sep 27 14:02", or "Sep 27 2:02 PM" on a 12-hour
// clock.

// "Sep 27 12:02 PM" plus the NUL; the day, hour and minute are truncated
// rather than overflowing if a struct tm field is out of range.
#define TIME_TEXT_SIZE 16

// "Signed in " plus a time.
#define LAST_AUTH_TEXT_SIZE (10 + TIME_TEXT_SIZE)

// "Synced " plus a time.
#define LAST_SYNC_TEXT_SIZE (7 + TIME_TEXT_SIZE)

// "Open settings on phone" and the NUL, the longest subtitle; a FHIR date
// (YYYY-MM-DD) after "Born " is shorter.
#define PATIENT_SUBTITLE_SIZE 23

// What the Sync Now row can do.
typedef enum {
  // Signed in and idle: selecting it starts a sync.
  SyncButtonReady,
  // A sync is running; selecting it does nothing.
  SyncButtonLoading,
  // Not signed in, so there is nothing to sync to.
  SyncButtonDisabled,
} SyncButtonState;

// Writes time as "Mon D HH:MM" (24-hour) or "Mon D H:MM AM" (12-hour).
// time->tm_mon must be 0-11.
void menu_text_format_time(char text[TIME_TEXT_SIZE], const struct tm *time, bool clock_24h);

// Writes "Synced <time>", or "Never synced" when last_sync is NULL.
void menu_text_format_last_sync(
  char text[LAST_SYNC_TEXT_SIZE],
  const struct tm *last_sync,
  bool clock_24h
);

// Writes the status row's title: "Sync failed" when the last sync this run
// failed, else menu_text_format_last_sync's text.
void menu_text_format_status_title(
  char text[LAST_SYNC_TEXT_SIZE],
  bool sync_failed,
  const struct tm *last_sync,
  bool clock_24h
);

// Writes "Signed in <time>", or "Not signed in" when last_auth is NULL.
void menu_text_format_last_auth(
  char text[LAST_AUTH_TEXT_SIZE],
  const struct tm *last_auth,
  bool clock_24h
);

// The patient row's title: "Not connected" when not signed in, "Unnamed
// patient" when the record has no name (patient_name is empty), else the name.
const char *menu_text_patient_title(bool connected, const char *patient_name);

// Writes the patient row's subtitle: "Open settings on phone" when not signed
// in, "Birth date unknown" when the record has none (birth_date is empty), else
// "Born <birth_date>", truncated to fit.
void menu_text_format_patient_subtitle(
  char text[PATIENT_SUBTITLE_SIZE],
  bool connected,
  const char *birth_date
);

// The checkbox row title for data_type.
const char *menu_text_data_type_title(DataType data_type);

// The Sync Now row's label for state.
const char *menu_text_sync_button_label(SyncButtonState state);
