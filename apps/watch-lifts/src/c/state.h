#pragma once

extern char *s_exercises[5];
extern int s_weights[2][5];
extern char *s_people_names[2];

// The most sets any exercise has; sizes the inner dimension of rep_count.
#define MAX_SETS 5

extern int s_set_counts[5];
extern int s_rep_count[2][5][MAX_SETS];
