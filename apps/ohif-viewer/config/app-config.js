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
  var loopback = false
  if (script && script.src) {
    var scriptUrl = new URL(script.src)
    basename = scriptUrl.pathname.slice(0, scriptUrl.pathname.lastIndexOf('/') + 1)
    loopback = scriptUrl.hostname === 'localhost' || scriptUrl.hostname === '127.0.0.1'
  }

  // SPA redirect: if we arrived via a 404.html redirect (the site's own or
  // ohif-viewer-dist's), restore the original route so the router picks it up.
  var params = new URLSearchParams(window.location.search)
  var redirectPath = params.get('redirect')
  if (redirectPath) {
    params.delete('redirect')
    if (redirectPath.indexOf(basename) === 0) {
      redirectPath = redirectPath.slice(basename.length)
    }
    redirectPath = redirectPath.replace(/^\/+/, '/')
    var remaining = params.toString()
    var target = basename + redirectPath.replace(/^\//, '')
    window.history.replaceState(
      null,
      '',
      target + (remaining ? '?' + remaining : '') + window.location.hash
    )
  }

  // Which SMART client this build is, decided by how it is served — the same
  // rule the other first-party apps apply through `import.meta.env.DEV`
  // (`apps/*/src/config.ts`), expressed at runtime here since nothing is
  // compiled. Served from the published site it is the `ohif-viewer` client
  // (gatekeeper migration `0009_seed_ohif_viewer_client`); served from a
  // loopback origin (`vp run -F ohif-viewer dev`) it is the debug-only
  // `ohif-viewer-dev` client (`gatekeeper-rust/src/seeding.rs`), whose id must
  // equal the `ohif-viewer-dev` app row's id for the app-relative redirect to
  // resolve. A `?client_id=` on the launch URL or a value saved from the SMART
  // Preferences panel still overrides this.
  var smartClientId = loopback ? 'ohif-viewer-dev' : 'ohif-viewer'

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
          smartClientId: smartClientId,
          // The scopes the EHR launch requests, replacing the extension's
          // built-in default (`patient/*.read` plus two `fhircast/` scopes the
          // Wildflower server does not implement). Read-only: the launch
          // Patient plus the ImagingStudy and DocumentReference searches the
          // FHIR data source issues. MUST equal, element for element and in
          // order, the `allowed_scopes` of the `ohif-viewer` client (gatekeeper
          // migration `0009_seed_ohif_viewer_client`) and of the
          // `ohif-viewer-dev` client (`gatekeeper-rust/src/seeding.rs`): a
          // requested scope the client is not allowed fails `/authorize`.
          smartScope:
            'launch openid fhirUser system/Patient.rs system/ImagingStudy.rs system/DocumentReference.rs',
        },
      },
    ],
  }
})()
