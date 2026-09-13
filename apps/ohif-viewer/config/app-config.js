// Runtime configuration for the OHIF viewer published at /ohif-viewer.
//
// OHIF loads this file (`window.config`) before its bundle, so everything here
// is a plain edit-and-redeploy setting: changing it never needs a rebuild of the
// prebuilt viewer that `prebuilt.json` pins. `src/build.ts` lays this file over
// the archive's own app-config.js. Exercised by `src/app-config.test.ts`.
;(function () {
  // This script is loaded as `./app-config.js` next to the viewer's index.html,
  // so its own URL says where the viewer lives. Deriving the router basename
  // from it lets one path-agnostic bundle serve wildflowerhealth.io/ohif-viewer/
  // and a PR preview at .../staging/pr-N/ohif-viewer/ alike.
  var script = document.currentScript
  var basename = '/'
  if (script && script.src) {
    var pathname = new URL(script.src).pathname
    basename = pathname.slice(0, pathname.lastIndexOf('/') + 1)
  }

  window.config = {
    name: 'wildflower/app-config.js',
    routerBasename: basename,
    extensions: [],
    modes: [],
    customizationService: {},
    // The worklist at the basename is the SMART launch entry point: an EHR
    // launches `<basename>?iss=<fhir base>&launch=<id>`, the FHIR data source
    // below runs the SMART EHR launch, and the OAuth redirect lands back on
    // the same path (the only OHIF route GitHub Pages serves natively).
    showStudyList: true,
    maxNumberOfWebWorkers: 3,
    showWarningMessageForCrossOrigin: true,
    showCPUFallbackMessage: true,
    showLoadingIndicator: true,
    strictZSpacingForVolumeViewport: true,
    showErrorDetails: 'always',
    investigationalUseDialog: { option: 'never' },
    defaultDataSourceName: 'fhir',
    dataSources: [
      {
        namespace: '@ohif/fhir-viewer.dataSourcesModule.fhir',
        sourceName: 'fhir',
        configuration: {
          friendlyName: 'FHIR R4 server (SMART on FHIR)',
          // No default server: a SMART launch supplies the FHIR base as `iss`,
          // and the viewer's FHIR panel accepts one by hand for standalone use.
          // The SMART client ID is likewise unsettled; until it is, a launch
          // passes `?client_id=` or the user enters one in the SMART
          // Preferences panel (both override this field).
          smartClientId: '',
        },
      },
    ],
  }
})()
