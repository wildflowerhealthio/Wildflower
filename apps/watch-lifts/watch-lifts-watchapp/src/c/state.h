#pragma once

#define PEOPLE_COUNT 2
#define EXERCISE_COUNT 5

extern char *s_exercises[EXERCISE_COUNT];
extern char *s_people_names[PEOPLE_COUNT];

// Each person's weight in pounds at each exercise, [person][exercise]: what
// the phone's settings page last sent, or the defaults until it has. Filled
// by state_load; change it only through state_set_weights, which persists it.
extern int s_weights[PEOPLE_COUNT][EXERCISE_COUNT];

// The most sets any exercise has; sizes the inner dimension of rep_count.
#define MAX_SETS 5

extern int s_set_counts[EXERCISE_COUNT];
extern int s_rep_count[PEOPLE_COUNT][EXERCISE_COUNT][MAX_SETS];

// Fills s_weights with the weights last persisted, or the defaults when none
// are, or what is persisted isn't the size s_weights is.
void state_load(void);

// Replaces s_weights with weights and persists them.
void state_set_weights(const int weights[PEOPLE_COUNT][EXERCISE_COUNT]);
