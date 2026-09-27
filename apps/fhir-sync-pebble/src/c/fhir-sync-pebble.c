#include <pebble.h>

#include "state.h"
#include "sync.h"
#include "windows/settings-window.h"

// The running app: its state, the window showing it and the sync writing it.
// main owns the one instance for the app's lifetime, and hands it to the
// AppMessage callbacks as their context.
typedef struct {
  AppState state;
  Window *settings_window;
  Sync sync;
} App;

// PebbleKit JS sends a settings message when the configuration page saves: the
// patient's name and birth date (empty when the record has none) and the time
// it received them. See src/pkjs/settings.js for the other side.
static void prv_receive_settings(App *app, DictionaryIterator *iterator) {
  Tuple *patient_name = dict_find(iterator, MESSAGE_KEY_PatientName);
  Tuple *birth_date = dict_find(iterator, MESSAGE_KEY_PatientBirthDate);
  Tuple *auth_time = dict_find(iterator, MESSAGE_KEY_AuthTime);
  if (patient_name == NULL || birth_date == NULL || auth_time == NULL) {
    APP_LOG(APP_LOG_LEVEL_ERROR, "Settings message is missing a key; ignoring it");
    return;
  }

  Connection connection = { .auth_time = auth_time->value->int32 };
  snprintf(
    connection.patient_name,
    sizeof(connection.patient_name),
    "%s",
    patient_name->value->cstring
  );
  snprintf(
    connection.birth_date, sizeof(connection.birth_date), "%s", birth_date->value->cstring
  );
  state_set_connection(&app->state, &connection);
  settings_window_reload(app->settings_window);
}

// A message from PebbleKit JS is either a sync's answer (SyncSucceeded) or
// the settings.
static void prv_inbox_received(DictionaryIterator *iterator, void *context) {
  App *app = context;
  Tuple *sync_succeeded = dict_find(iterator, MESSAGE_KEY_SyncSucceeded);
  if (sync_succeeded != NULL) {
    sync_handle_result(&app->sync, sync_succeeded->value->int32 != 0);
    return;
  }
  prv_receive_settings(app, iterator);
}

static void prv_inbox_dropped(AppMessageResult reason, void *context) {
  APP_LOG(APP_LOG_LEVEL_ERROR, "Message from the phone dropped: %d", (int)reason);
}

static void prv_outbox_sent(DictionaryIterator *iterator, void *context) {
  App *app = context;
  sync_handle_outbox_sent(&app->sync);
}

static void prv_outbox_failed(DictionaryIterator *iterator, AppMessageResult reason, void *context) {
  App *app = context;
  sync_handle_outbox_failed(&app->sync, reason);
}

// Exists only to give the app a .bss section; see "The app needs a .bss" in
// AGENTS.md. main reads it so --gc-sections keeps it.
static volatile uint8_t s_bss_anchor;

static void prv_sync_now(void *context) {
  App *app = context;
  sync_start(&app->sync);
}

int main(void) {
  (void)s_bss_anchor;
  // app_event_loop returns only as the app exits, so app outlives every
  // callback that points at it.
  App app;
  state_load(&app.state);
  app.settings_window = settings_window_push(&app.state, prv_sync_now, &app);
  sync_init(&app.sync, &app.state, app.settings_window);

  app_message_set_context(&app);
  app_message_register_inbox_received(prv_inbox_received);
  app_message_register_inbox_dropped(prv_inbox_dropped);
  app_message_register_outbox_sent(prv_outbox_sent);
  app_message_register_outbox_failed(prv_outbox_failed);
  // The outbox fits an hour of minute history: MINUTE_WIRE_HOUR_SIZE bytes
  // plus its hour, types and the dictionary's overhead.
  app_message_open(256, 512);

  app_event_loop();
}
