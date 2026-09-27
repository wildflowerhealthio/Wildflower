#include <pebble.h>

#include "./exercise-detail-window.h"
#include "./exercise-detail-window/reps-layer.h"
#include "../ui-constants.h"
#include "../state.h"
#include "../views/title-layer.h"
#include "../views/stats-bar-layer.h"

const int num_people = 2;

// Each window keeps its own ExerciseDetailWindow as its user data, so two can
// be on the stack at once (e.g. a double press during the push animation).
typedef struct ExerciseDetailWindow {
  int exercise_index;
  TitleLayer *title_layer;
  RepsLayer **reps_layers;
  StatsBarLayer *stats_bar_layer;
} ExerciseDetailWindow;

static void prv_window_load(Window *window) {
  ExerciseDetailWindow *exercise_detail_window = window_get_user_data(window);
  Layer *root_layer = window_get_root_layer(window);
  GRect bounds = layer_get_bounds(root_layer);

  exercise_detail_window->title_layer = title_layer_create(
    GRect(0, 0, bounds.size.w, title_bar_height),
    s_exercises[exercise_detail_window->exercise_index]
  );
  layer_add_child(root_layer, title_layer_get_layer(exercise_detail_window->title_layer));

  exercise_detail_window->stats_bar_layer = stats_bar_layer_create(
    GRect(0, bounds.size.h - stats_bar_height, bounds.size.w, stats_bar_height)
  );
  layer_add_child(root_layer, stats_bar_layer_get_layer(exercise_detail_window->stats_bar_layer));

  int rep_layer_height = (bounds.size.h - (title_bar_height + stats_bar_height)) / num_people;
  exercise_detail_window->reps_layers = malloc(sizeof(RepsLayer *) * num_people);
  for (int i = 0; i < num_people; i++) {
    exercise_detail_window->reps_layers[i] = reps_layer_create(
      GRect(0, title_bar_height + i * rep_layer_height, bounds.size.w, rep_layer_height)
    );

    reps_layer_set_person_name(exercise_detail_window->reps_layers[i], s_people_names[i]);
    reps_layer_set_weight(
      exercise_detail_window->reps_layers[i],
      s_weights[i][exercise_detail_window->exercise_index]
    );

    reps_layer_set_reps(
      exercise_detail_window->reps_layers[i],
      s_rep_count[i][exercise_detail_window->exercise_index],
      s_set_counts[exercise_detail_window->exercise_index]
    );

    layer_add_child(root_layer, reps_layer_get_layer(exercise_detail_window->reps_layers[i]));
  }
}

static void prv_window_unload(Window *window) {
  ExerciseDetailWindow *exercise_detail_window = window_get_user_data(window);
  stats_bar_layer_destroy(exercise_detail_window->stats_bar_layer);
  for (int i = 0; i < num_people; i++) {
    reps_layer_destroy(exercise_detail_window->reps_layers[i]);
  }
  free(exercise_detail_window->reps_layers);
  title_layer_destroy(exercise_detail_window->title_layer);
  free(exercise_detail_window);
  window_destroy(window);
}

void exercise_detail_window_push(int exercise_index) {
  ExerciseDetailWindow *exercise_detail_window = malloc(sizeof(ExerciseDetailWindow));
  exercise_detail_window->exercise_index = exercise_index;
  Window *window = window_create();
  window_set_user_data(window, exercise_detail_window);
  window_set_window_handlers(
    window,
    (WindowHandlers){
      .load = prv_window_load,
      .unload = prv_window_unload,
    }
  );

  window_stack_push(window, true);
}
