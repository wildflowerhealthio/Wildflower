#include "status-row.h"
#include "local-time.h"
#include "../../menu-text.h"

void status_row_draw(GContext *ctx, const Layer *cell_layer, const AppState *state) {
  bool clock_24h = clock_is_24h_style();
  char title[LAST_SYNC_TEXT_SIZE];
  menu_text_format_status_title(
    title,
    state->sync_failed,
    local_time_or_null(&state->last_sync_time),
    clock_24h
  );

  time_t auth_time = state->connected ? state->connection.auth_time : 0;
  char last_auth_text[LAST_AUTH_TEXT_SIZE];
  menu_text_format_last_auth(last_auth_text, local_time_or_null(&auth_time), clock_24h);

  menu_cell_basic_draw(ctx, cell_layer, title, last_auth_text, NULL);
}
