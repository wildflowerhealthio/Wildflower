#include "settings-menu-layer.h"
#include "settings-menu-layer/data-type-row.h"
#include "settings-menu-layer/patient-row.h"
#include "settings-menu-layer/status-row.h"
#include "settings-menu-layer/sync-now-row.h"

// Rows top to bottom: the status row, the patient row, one checkbox row per
// DataType, then Sync Now.
enum {
  RowStatus,
  RowPatient,
  RowFirstDataType,
  RowSyncNow = RowFirstDataType + DATA_TYPE_COUNT,
  ROW_COUNT,
};

// The MenuLayer's callback context is the SettingsMenuLayer.
struct SettingsMenuLayer {
  MenuLayer *menu_layer;
  AppState *state;
  SyncNowHandler on_sync_now;
  void *sync_now_context;
};

static uint16_t prv_get_num_rows(MenuLayer *menu_layer, uint16_t section_index, void *context) {
  return ROW_COUNT;
}

static void prv_draw_row(
  GContext *ctx,
  const Layer *cell_layer,
  MenuIndex *cell_index,
  void *context
) {
  const SettingsMenuLayer *settings_menu_layer = context;
  const AppState *state = settings_menu_layer->state;
  int row = cell_index->row;
  if (row == RowStatus) {
    status_row_draw(ctx, cell_layer, state);
  } else if (row == RowPatient) {
    patient_row_draw(ctx, cell_layer, state);
  } else if (row == RowSyncNow) {
    sync_now_row_draw(ctx, cell_layer, state);
  } else {
    data_type_row_draw(ctx, cell_layer, state, row - RowFirstDataType);
  }
}

static int16_t prv_get_cell_height(
  MenuLayer *menu_layer,
  MenuIndex *cell_index,
  void *context
) {
  return 48;
}

static void prv_select_click(MenuLayer *menu_layer, MenuIndex *cell_index, void *context) {
  SettingsMenuLayer *settings_menu_layer = context;
  AppState *state = settings_menu_layer->state;
  int row = cell_index->row;
  if (row >= RowFirstDataType && row < RowSyncNow) {
    state_toggle_data_type(state, row - RowFirstDataType);
    menu_layer_reload_data(menu_layer);
  } else if (row == RowSyncNow && state_sync_button_state(state) == SyncButtonReady) {
    settings_menu_layer->on_sync_now(settings_menu_layer->sync_now_context);
  }
  // The status and patient rows have no action.
}

SettingsMenuLayer *settings_menu_layer_create(
  GRect frame,
  Window *click_window,
  AppState *state,
  SyncNowHandler on_sync_now,
  void *sync_now_context
) {
  SettingsMenuLayer *settings_menu_layer = malloc(sizeof(SettingsMenuLayer));
  MenuLayer *menu_layer = menu_layer_create(frame);
  *settings_menu_layer = (SettingsMenuLayer){
    .menu_layer = menu_layer,
    .state = state,
    .on_sync_now = on_sync_now,
    .sync_now_context = sync_now_context,
  };

  menu_layer_set_click_config_onto_window(menu_layer, click_window);
  menu_layer_set_highlight_colors(menu_layer, GColorCobaltBlue, GColorWhite);
  menu_layer_set_callbacks(
    menu_layer,
    settings_menu_layer,
    (MenuLayerCallbacks){
      .get_num_rows = prv_get_num_rows,
      .draw_row = prv_draw_row,
      .get_cell_height = prv_get_cell_height,
      .select_click = prv_select_click,
    }
  );
  menu_layer_pad_bottom_enable(menu_layer, true);
  return settings_menu_layer;
}

void settings_menu_layer_destroy(SettingsMenuLayer *settings_menu_layer) {
  menu_layer_destroy(settings_menu_layer->menu_layer);
  free(settings_menu_layer);
}

Layer *settings_menu_layer_get_layer(SettingsMenuLayer *settings_menu_layer) {
  return menu_layer_get_layer(settings_menu_layer->menu_layer);
}

void settings_menu_layer_reload(SettingsMenuLayer *settings_menu_layer) {
  menu_layer_reload_data(settings_menu_layer->menu_layer);
}
