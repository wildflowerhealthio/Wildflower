#include <pebble.h>

#include "exercise-detail-window.h"
#include "exercise-detail-window/reps-layer.h"
#include "../ui-constants.h"
#include "../state.h"
#include "../views/title-layer.h"
#include "../views/stats-bar-layer.h"

typedef struct ExerciseDetailWindow
{
  int exercise_index;
  TitleLayer *title_layer;
  RepsLayer *reps_layer;
  StatsBarLayer *stats_bar_layer;
} ExerciseDetailWindow;

// Window handlers receive only the Window, and its user data is reserved for
// the StatsBarLayer, so the single instance is reached through this static.
static ExerciseDetailWindow *s_exercise_detail_window;

static void prv_window_load(Window *window)
{
  Layer *root_layer = window_get_root_layer(window);
  GRect bounds = layer_get_bounds(root_layer);

  s_exercise_detail_window->title_layer = title_layer_create(
      GRect(0, 0, bounds.size.w, title_bar_height),
      s_exercises[s_exercise_detail_window->exercise_index]);
  layer_add_child(root_layer, title_layer_get_layer(s_exercise_detail_window->title_layer));

  s_exercise_detail_window->reps_layer = reps_layer_create(
      GRect(0, title_bar_height, bounds.size.w, bounds.size.h - title_bar_height - stats_bar_height));
  layer_add_child(root_layer, reps_layer_get_layer(s_exercise_detail_window->reps_layer));

  s_exercise_detail_window->stats_bar_layer = stats_bar_layer_create(
      GRect(0, bounds.size.h - stats_bar_height, bounds.size.w, stats_bar_height));
  layer_add_child(root_layer, stats_bar_layer_get_layer(s_exercise_detail_window->stats_bar_layer));
  window_set_user_data(window, s_exercise_detail_window->stats_bar_layer);
}

static void prv_window_appear(Window *window)
{
  stats_bar_layer_refresh(s_exercise_detail_window->stats_bar_layer);
}

static void prv_window_unload(Window *window)
{
  stats_bar_layer_destroy(s_exercise_detail_window->stats_bar_layer);
  reps_layer_destroy(s_exercise_detail_window->reps_layer);
  title_layer_destroy(s_exercise_detail_window->title_layer);
  free(s_exercise_detail_window);
  s_exercise_detail_window = NULL;
  window_destroy(window);
}

void exercise_detail_window_push(int exercise_index)
{
  s_exercise_detail_window = malloc(sizeof(ExerciseDetailWindow));
  s_exercise_detail_window->exercise_index = exercise_index;
  Window *window = window_create();
  window_set_window_handlers(window, (WindowHandlers){
                                         .load = prv_window_load,
                                         .appear = prv_window_appear,
                                         .unload = prv_window_unload,
                                     });
  window_stack_push(window, true);
}
