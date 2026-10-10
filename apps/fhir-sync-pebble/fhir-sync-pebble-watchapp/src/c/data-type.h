#pragma once

// The kinds of Pebble data the watch can sync to the FHIR server, one checkbox
// row each. Kept free of pebble.h so menu-text.c can be tested on the host.
typedef enum {
  DataTypeHealthActivity,
  DataTypeHeartRate,
  DataTypeSteps,
  DataTypeOrientation,
  DataTypeMovement,
  DataTypeAmbientLight,
  DATA_TYPE_COUNT,
} DataType;
