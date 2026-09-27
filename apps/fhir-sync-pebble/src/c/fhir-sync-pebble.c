#include <pebble.h>

#include "state.h"
#include "windows/settings-window.h"

// The running app: its state and the window showing it. main owns the one
// instance for the app's lifetime, and hands it to the AppMessage callbacks as
// their context.
typedef struct {
  AppState state;
  Window *settings_window;
} App;

// PebbleKit JS sends one message when the configuration page saves: the
// patient's name and birth date (empty when the record has none) and the time
// it received them. See src/pkjs/settings.js for the other side.
static void prv_inbox_received(DictionaryIterator *iterator, void *context) {
  App *app = context;
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

static void prv_inbox_dropped(AppMessageResult reason, void *context) {
  APP_LOG(APP_LOG_LEVEL_ERROR, "Settings message dropped: %d", (int)reason);
}

int main(void) {
  // app_event_loop returns only as the app exits, so app outlives every
  // callback that points at it.
  App app;
  state_load(&app.state);
  app.settings_window = settings_window_push(&app.state);

  app_message_set_context(&app);
  app_message_register_inbox_received(prv_inbox_received);
  app_message_register_inbox_dropped(prv_inbox_dropped);
  app_message_open(256, 64);

  app_event_loop();
}
