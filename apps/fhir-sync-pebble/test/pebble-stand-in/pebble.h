// A host stand-in for the part of the Pebble SDK's pebble.h that state.c and
// sync.c use, so the host tests can build them: the standard headers pebble.h
// brings in, and declarations of the SDK calls they make, which each driver
// defines (state-driver.c keeps persist storage in memory; sync-driver.c
// records AppMessages and the timer, and serves HealthService from a list).
// state.test.ts and sync.test.ts put this directory on the include path.

#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

typedef int32_t status_t;

// The watch's clock, which sync-driver.c sets.
time_t stand_in_time(time_t *now);
#define time(now) stand_in_time(now)

#define SECONDS_PER_MINUTE 60
#define SECONDS_PER_HOUR 3600

// Logging goes to stderr, which the tests don't read.
#define APP_LOG(level, ...) ((void)(level), fprintf(stderr, __VA_ARGS__), fputc('\n', stderr))
#define APP_LOG_LEVEL_ERROR 1
#define APP_LOG_LEVEL_WARNING 2

// The message keys sync.c writes; the SDK generates them from package.json.
enum {
  MESSAGE_KEY_ActivityType = 3,
  MESSAGE_KEY_ActivityStart,
  MESSAGE_KEY_ActivityEnd,
  MESSAGE_KEY_ActivityCount,
  MESSAGE_KEY_SyncSucceeded,
  MESSAGE_KEY_MinuteHourStart,
  MESSAGE_KEY_MinuteTypes,
  MESSAGE_KEY_MinuteData,
  MESSAGE_KEY_MinuteHourCount,
  MESSAGE_KEY_SyncStart,
  MESSAGE_KEY_SyncId,
  MESSAGE_KEY_ConnectionId,
};

// Persist storage.
bool persist_exists(const uint32_t key);
int32_t persist_read_int(const uint32_t key);
status_t persist_write_int(const uint32_t key, const int32_t value);
int persist_read_string(const uint32_t key, char *buffer, const size_t buffer_size);
int persist_write_string(const uint32_t key, const char *cstring);

// UI types the headers name.
typedef struct Window Window;
typedef struct Layer Layer;
typedef struct {
  int16_t x;
  int16_t y;
  int16_t w;
  int16_t h;
} GRect;

// Timers.
typedef struct AppTimer AppTimer;
typedef void (*AppTimerCallback)(void *data);
AppTimer *app_timer_register(uint32_t timeout_ms, AppTimerCallback callback, void *callback_data);
bool app_timer_reschedule(AppTimer *timer, uint32_t new_timeout_ms);
void app_timer_cancel(AppTimer *timer);

// AppMessage.
typedef enum {
  APP_MSG_OK = 0,
  APP_MSG_SEND_TIMEOUT = 2,
  APP_MSG_BUSY = 64,
} AppMessageResult;
typedef struct DictionaryIterator DictionaryIterator;
typedef int DictionaryResult;
AppMessageResult app_message_outbox_begin(DictionaryIterator **iterator);
AppMessageResult app_message_outbox_send(void);
DictionaryResult dict_write_int32(
  DictionaryIterator *iterator,
  const uint32_t key,
  const int32_t value
);
DictionaryResult dict_write_cstring(
  DictionaryIterator *iterator,
  const uint32_t key,
  const char *cstring
);
DictionaryResult dict_write_data(
  DictionaryIterator *iterator,
  const uint32_t key,
  const uint8_t *data,
  const uint16_t size
);

// HealthService.
typedef enum {
  HealthActivityNone = 0,
  HealthActivitySleep = 1 << 0,
  HealthActivityRestfulSleep = 1 << 1,
  HealthActivityWalk = 1 << 2,
  HealthActivityRun = 1 << 3,
  HealthActivityOpenWorkout = 1 << 4,
} HealthActivity;
typedef uint32_t HealthActivityMask;
#define HealthActivityMaskAll 0x1f
typedef enum {
  HealthIterationDirectionPast,
  HealthIterationDirectionFuture,
} HealthIterationDirection;
typedef bool (*HealthActivityIteratorCB)(
  HealthActivity activity,
  time_t time_start,
  time_t time_end,
  void *context
);
bool health_service_activities_iterate(
  HealthActivityMask activity_mask,
  time_t time_start,
  time_t time_end,
  HealthIterationDirection direction,
  HealthActivityIteratorCB callback,
  void *context
);
typedef enum {
  AmbientLightLevelUnknown = 0,
  AmbientLightLevelVeryDark,
  AmbientLightLevelDark,
  AmbientLightLevelLight,
  AmbientLightLevelVeryLight,
} AmbientLightLevel;
typedef struct {
  uint8_t steps;
  uint8_t orientation;
  uint16_t vmc;
  bool is_invalid;
  AmbientLightLevel light;
  uint8_t heart_rate_bpm;
} HealthMinuteData;
uint32_t health_service_get_minute_history(
  HealthMinuteData *minute_data,
  uint32_t max_records,
  time_t *time_start,
  time_t *time_end
);
