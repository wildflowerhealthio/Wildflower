#pragma once

#include <pebble.h>

#include "../state.h"

// The settings menu: the status row (last sync, last sign-in), the patient
// row, a checkbox row per DataType, then Sync Now, all read from state, which
// must outlive the layer. Selecting a checkbox row toggles it.
typedef struct SettingsMenuLayer SettingsMenuLayer;

// Takes over click_window's click config so the buttons scroll the menu.
SettingsMenuLayer *settings_menu_layer_create(
  GRect frame,
  Window *click_window,
  AppState *state
);
void settings_menu_layer_destroy(SettingsMenuLayer *settings_menu_layer);
Layer *settings_menu_layer_get_layer(SettingsMenuLayer *settings_menu_layer);

// Redraws the menu after the state behind it changed.
void settings_menu_layer_reload(SettingsMenuLayer *settings_menu_layer);
