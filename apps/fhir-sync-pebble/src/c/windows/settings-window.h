#pragma once

#include <pebble.h>

#include "../state.h"

// The app's one window, holding the settings menu (views/settings-menu-layer.h)
// over state, which must outlive the window. Returns the window, which
// destroys itself when popped.
Window *settings_window_push(AppState *state);

// Redraws window's menu after the state behind it changed.
void settings_window_reload(Window *window);
