#include <pebble.h>

#include "state.h"

char *s_exercises[5] = {
    "Squat",
    "Bench Press",
    "Bent Over Row",
    "Overhead Press",
    "Deadlift"};

// static int s_sets[5] = {5, 5, 5, 5, 1};

int s_weights[2][5] = {
    {60, 50, 50, 50, 85},
    {65, 55, 55, 45, 85}};

char *s_people_names[] = {"Ruth", "Chloe"};
