#include <pebble.h>

#include "exercise-list.h"
#include "ui-constants.h"
#include "state.h"
#include "title-layer.h"
#include "clock-layer.h"
#include "heart-rate-layer.h"

static MenuLayer *s_menu_layer;

// static char *s_exercises[5] = {
//     "Squat",
//     "Bench Press",
//     "Bent Over Row",
//     "Overhead Press",
//     "Deadlift"};

// // static int s_sets[5] = {5, 5, 5, 5, 1};

// static int s_weights[2][5] = {
//     {60, 50, 50, 50, 85},
//     {65, 55, 55, 45, 85}};

// static char *s_people_names[] = {"Ruth", "Chloe"};

// static int s_editing_set_index = -1;

/// /////////

static uint16_t get_num_rows_callback(MenuLayer *menu_layer,
                                      uint16_t section_index, void *context)
{
  int num_exercises = sizeof(s_exercises) / sizeof(s_exercises[0]);
  const uint16_t num_rows = num_exercises;
  return num_rows;
}

static void draw_row_callback(GContext *ctx, const Layer *cell_layer,
                              MenuIndex *cell_index, void *context)
{

  int exercise_index = cell_index->row;

  char label[100];

  snprintf(
      label,
      sizeof(label),
      "%s: %i lbs / %s: %i lbs",
      s_people_names[0],
      s_weights[0][exercise_index],
      s_people_names[1],
      s_weights[1][exercise_index]);

  char *exercise_title = s_exercises[exercise_index];

  menu_cell_basic_draw(ctx, cell_layer, exercise_title, label, NULL);
}

static int16_t get_cell_height_callback(struct MenuLayer *menu_layer,
                                        MenuIndex *cell_index, void *context)
{
  return 50;
}

static void select_callback(struct MenuLayer *menu_layer,
                            MenuIndex *cell_index, void *context)
{
  s_editing_set_index = cell_index->row;
  menu_layer_reload_data(s_menu_layer);
}

static void long_select_callback(struct MenuLayer *menu_layer,
                                 MenuIndex *cell_index, void *context)
{
  menu_layer_reload_data(s_menu_layer);
}

/////

Window *detail_window;

void push_detail_window(int exercise_index)
{
  detail_window = window_create();

  Layer *window_layer = window_get_root_layer(detail_window);
  GRect bounds = layer_get_bounds(window_layer);

  bounds.size.h -= (title_bar_height + stats_bar_height); // Adjust the height to make room for padding
  bounds.origin.y = title_bar_height;
  // Create the MenuLayer

  title_layer_window_load(detail_window, exercise_index);
  clock_layer_window_load(detail_window);
  heart_rate_layer_window_load(detail_window);
  window_stack_push(detail_window, true);
}

void pop_detail_window()
{
  s_editing_set_index = -1;
  window_stack_remove(detail_window, true);
  title_layer_window_unload(detail_window);
  clock_layer_window_unload(detail_window);
  heart_rate_layer_window_unload(detail_window);
  render_heartrate();
  detail_window = NULL;
}
