#include <stdio.h>

#include "menu-text.h"

static const char *const s_month_abbreviations[12] = {
  "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
};

static const char *const s_data_type_titles[DATA_TYPE_COUNT] = {
  [DataTypeHealthActivity] = "Health Activity",
  [DataTypeHeartRate] = "Heart Rate",
  [DataTypeSteps] = "Steps",
  [DataTypeOrientation] = "Orientation",
  [DataTypeMovement] = "Movement",
  [DataTypeAmbientLight] = "Ambient Light Level",
};

void menu_text_format_time(char text[TIME_TEXT_SIZE], const struct tm *time, bool clock_24h) {
  const char *month = s_month_abbreviations[time->tm_mon];
  if (clock_24h) {
    snprintf(
      text,
      TIME_TEXT_SIZE,
      "%s %d %02d:%02d",
      month,
      time->tm_mday,
      time->tm_hour,
      time->tm_min
    );
    return;
  }
  int hour = time->tm_hour % 12 == 0 ? 12 : time->tm_hour % 12;
  const char *meridiem = time->tm_hour < 12 ? "AM" : "PM";
  snprintf(
    text,
    TIME_TEXT_SIZE,
    "%s %d %d:%02d %s",
    month,
    time->tm_mday,
    hour,
    time->tm_min,
    meridiem
  );
}

void menu_text_format_last_sync(
  char text[LAST_SYNC_TEXT_SIZE],
  const struct tm *last_sync,
  bool clock_24h
) {
  if (last_sync == NULL) {
    snprintf(text, LAST_SYNC_TEXT_SIZE, "Never synced");
    return;
  }
  char time_text[TIME_TEXT_SIZE];
  menu_text_format_time(time_text, last_sync, clock_24h);
  snprintf(text, LAST_SYNC_TEXT_SIZE, "Synced %s", time_text);
}

void menu_text_format_status_title(
  char text[LAST_SYNC_TEXT_SIZE],
  bool sync_failed,
  const struct tm *last_sync,
  bool clock_24h
) {
  if (sync_failed) {
    snprintf(text, LAST_SYNC_TEXT_SIZE, "Sync failed");
    return;
  }
  menu_text_format_last_sync(text, last_sync, clock_24h);
}

void menu_text_format_last_auth(
  char text[LAST_AUTH_TEXT_SIZE],
  const struct tm *last_auth,
  bool clock_24h
) {
  if (last_auth == NULL) {
    snprintf(text, LAST_AUTH_TEXT_SIZE, "Not signed in");
    return;
  }
  char time_text[TIME_TEXT_SIZE];
  menu_text_format_time(time_text, last_auth, clock_24h);
  snprintf(text, LAST_AUTH_TEXT_SIZE, "Signed in %s", time_text);
}

const char *menu_text_patient_title(bool connected, const char *patient_name) {
  if (!connected) {
    return "Not connected";
  }
  return patient_name[0] == '\0' ? "Unnamed patient" : patient_name;
}

void menu_text_format_patient_subtitle(
  char text[PATIENT_SUBTITLE_SIZE],
  bool connected,
  const char *birth_date
) {
  if (!connected) {
    snprintf(text, PATIENT_SUBTITLE_SIZE, "Open settings on phone");
    return;
  }
  if (birth_date[0] == '\0') {
    snprintf(text, PATIENT_SUBTITLE_SIZE, "Birth date unknown");
    return;
  }
  snprintf(text, PATIENT_SUBTITLE_SIZE, "Born %s", birth_date);
}

const char *menu_text_data_type_title(DataType data_type) {
  return s_data_type_titles[data_type];
}

const char *menu_text_sync_button_label(SyncButtonState state) {
  // Disabled keeps the Ready label; the row draws it greyed out.
  return state == SyncButtonLoading ? "Syncing..." : "Sync Now";
}
