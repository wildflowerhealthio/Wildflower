#include "data-type-row.h"
#include "local-time.h"
#include "../../menu-text.h"

#define CELL_PADDING 5
#define CHECKBOX_SIZE 14

// menu_cell_basic_draw has no room for a trailing checkbox, so this row lays
// out its own title and subtitle to its left.
void data_type_row_draw(
  GContext *ctx,
  const Layer *cell_layer,
  const AppState *state,
  DataType data_type
) {
  GRect bounds = layer_get_bounds(cell_layer);
  GColor foreground = menu_cell_layer_is_highlighted(cell_layer) ? GColorWhite : GColorBlack;
  int text_width = bounds.size.w - 3 * CELL_PADDING - CHECKBOX_SIZE;

  char subtitle[LAST_SYNC_TEXT_SIZE];
  menu_text_format_last_sync(
    subtitle,
    local_time_or_null(&state->data_type_last_sync_times[data_type]),
    clock_is_24h_style()
  );

  graphics_context_set_text_color(ctx, foreground);
  graphics_draw_text(
    ctx,
    menu_text_data_type_title(data_type),
    fonts_get_system_font(FONT_KEY_GOTHIC_24_BOLD),
    GRect(CELL_PADDING, -2, text_width, 28),
    GTextOverflowModeTrailingEllipsis,
    GTextAlignmentLeft,
    NULL
  );
  graphics_draw_text(
    ctx,
    subtitle,
    fonts_get_system_font(FONT_KEY_GOTHIC_18),
    GRect(CELL_PADDING, 22, text_width, 22),
    GTextOverflowModeTrailingEllipsis,
    GTextAlignmentLeft,
    NULL
  );

  GRect checkbox = GRect(
    bounds.size.w - CELL_PADDING - CHECKBOX_SIZE,
    (bounds.size.h - CHECKBOX_SIZE) / 2,
    CHECKBOX_SIZE,
    CHECKBOX_SIZE
  );
  graphics_context_set_stroke_color(ctx, foreground);
  graphics_context_set_stroke_width(ctx, 1);
  graphics_draw_rect(ctx, checkbox);
  if (state->data_type_enabled[data_type]) {
    graphics_context_set_fill_color(ctx, foreground);
    graphics_fill_rect(ctx, grect_inset(checkbox, GEdgeInsets(3)), 0, GCornerNone);
  }
}
