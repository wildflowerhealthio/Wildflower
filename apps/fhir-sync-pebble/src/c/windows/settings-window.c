#include <pebble.h>

#include "settings-window.h"
#include "../views/settings-menu-layer.h"

// The window's user data. The menu layer exists between load and unload.
typedef struct {
  AppState *state;
  SettingsMenuLayer *settings_menu_layer;
} SettingsWindowData;

static void prv_window_load(Window *window) {
  SettingsWindowData *data = window_get_user_data(window);
  Layer *window_layer = window_get_root_layer(window);
  data->settings_menu_layer =
    settings_menu_layer_create(layer_get_bounds(window_layer), window, data->state);
  layer_add_child(window_layer, settings_menu_layer_get_layer(data->settings_menu_layer));
}

static void prv_window_unload(Window *window) {
  SettingsWindowData *data = window_get_user_data(window);
  settings_menu_layer_destroy(data->settings_menu_layer);
  free(data);
  window_destroy(window);
}

Window *settings_window_push(AppState *state) {
  SettingsWindowData *data = malloc(sizeof(SettingsWindowData));
  *data = (SettingsWindowData){ .state = state };
  Window *window = window_create();
  window_set_user_data(window, data);
  window_set_window_handlers(
    window,
    (WindowHandlers){
      .load = prv_window_load,
      .unload = prv_window_unload,
    }
  );
  window_stack_push(window, true);
  return window;
}

void settings_window_reload(Window *window) {
  SettingsWindowData *data = window_get_user_data(window);
  settings_menu_layer_reload(data->settings_menu_layer);
}
