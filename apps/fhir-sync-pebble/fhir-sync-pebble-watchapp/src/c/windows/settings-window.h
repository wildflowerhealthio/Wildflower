#pragma once

#include <pebble.h>

#include "../state.h"
#include "../views/settings-menu-layer.h"

// The app's one window, holding the settings menu (views/settings-menu-layer.h)
// over state, which must outlive the window; the menu's Sync Now calls
// on_sync_now with sync_now_context. Returns the window, which destroys itself
// when popped.
Window *settings_window_push(AppState *state, SyncNowHandler on_sync_now, void *sync_now_context);

// Redraws window's menu after the state behind it changed.
void settings_window_reload(Window *window);
