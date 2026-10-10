#include "sync-now-row.h"
#include "../../menu-text.h"

void sync_now_row_draw(GContext *ctx, const Layer *cell_layer, const AppState *state) {
  SyncButtonState sync_button_state = state_sync_button_state(state);
  bool highlighted = menu_cell_layer_is_highlighted(cell_layer);
  GColor foreground;
  if (sync_button_state == SyncButtonReady) {
    foreground = highlighted ? GColorWhite : GColorBlack;
  } else {
    foreground = highlighted ? GColorLightGray : GColorDarkGray;
  }

  GRect bounds = layer_get_bounds(cell_layer);
  graphics_context_set_text_color(ctx, foreground);
  graphics_draw_text(
    ctx,
    menu_text_sync_button_label(sync_button_state),
    fonts_get_system_font(FONT_KEY_GOTHIC_24_BOLD),
    GRect(0, (bounds.size.h - 28) / 2, bounds.size.w, 28),
    GTextOverflowModeTrailingEllipsis,
    GTextAlignmentCenter,
    NULL
  );
}
