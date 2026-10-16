# Telemetry Explanation

How a Wildflower web app decides what, if anything, it reports to Sentry, and why nothing is reported before the visitor says yes.

The consent model, the URL anonymizer and the event scrubber are pure functions in `telemetry-core` (`consent.ts`, `anonymize-url.ts`, `scrub-event.ts`, `consented-config.ts`); `telemetry-web`'s `initConsentedTelemetry` (`consented.ts`) applies them to the Sentry browser SDK. `telemetry-react` asks the question: the consent dialog, the gate that holds an app behind it, and the status control that reopens it. It also holds what an app root does with the answer: `useConsentedTelemetryStart` starts telemetry from it, and `CrashReportingBoundary` reports render crashes. The dialog's words are `TELEMETRY_CONSENT_COPY` in `branding-core`.

## Two switches, both off

The visitor answers two independent questions, and each is an opt-in:

- **Crash reports** send errors: the exception, its stack, and the breadcrumbs leading up to it. An error can carry whatever data the app had loaded, so this switch is the one that may send record contents. The apps are early-stage and unaudited, and the dialog asks visitors to use their own judgement about which records they connect.
- **Performance** sends page loads, request timings and route names through Sentry's browser tracing, sampled at the build's `tracesSampleRate`, together with the app's own OpenTelemetry spans, which reach Sentry through its span processor. Browser tracing runs with INP off, because INP spans are sent outside transactions and would skip the performance switch and URL scrubbing. It sends no record contents.

Both switches report to the same Sentry project, so the DSN stays while either is on. With only performance on, the SDK's `beforeSend` hook drops every error event; with only crash reports on, the trace sample rate is 0 and `beforeSendTransaction` drops every transaction. Profiling and session replay belong to neither switch, so they never run. The dialog names Sentry as where reports go, so no answer turns on the OTLP exporter, whose spans would pass no scrubbing hook. The SDK's `dataCollection` is turned off for user fields, cookies, headers, bodies and query parameters whatever the answer.

## URLs are reduced to their shape

Every event either switch sends passes through `scrubEvent`, which runs each URL it carries (the request URL and `Referer`, fetch and navigation breadcrumbs, span attributes such as `url.full`, `url.path` and `lcp.url`, span descriptions, the transaction name) through `anonymizeUrl`, runs the span attributes that carry a host on its own (`server.address`, `url.domain`, `http.host`, `net.peer.name`) through `anonymizeHost`, and drops the span attributes that carry a query string, a fragment or an HTTP header. `anonymizeUrl` drops the query string, fragment and credentials, and keeps the scheme, the host and the path only where they cannot carry data. Relative references keep their form, so `Observation?patient=1` becomes `Observation`:

```text
https://fhir.example/r4/Patient/123/_history/2?_format=json
https://{host}/r4/Patient/{id}/_history/{vid}

http://tauri.localhost/servers/android-emu.relay.wildflowerhealth.io
http://tauri.localhost/servers/{id}
```

Both the host and the path are allowlists, so a shape the anonymizer does not know is replaced rather than reported:

- **Hosts.** The host and port stay only when the hostname is `localhost`, `tauri.localhost` or `wildflowerhealth.io`, the apex that serves the hosted apps. Every other host, the apex's subdomains included (a relay tunnel, a personal server), becomes `{host}` and loses its port, since a server's name is the user's choice.
- **Path segments.** The segment after `_history` becomes `{vid}`, and the segment after a resource type becomes `{id}` whatever its own shape, since a FHIR id can be a plain word. Any other segment stays only if it is a lowercase route word, hyphens allowed (`servers`, `oauth-consent`, `.well-known`), a resource type, an operation or interaction (`$everything`, `_search`: a `$` or `_` and lowercase words), or one of a short list of FHIR base-path names (`FHIR`, `R4`, `R4B`, `R5`, `STU3`, `DSTU2`, `baseR4`, …). Everything else becomes `{id}`: domains, UUIDs, numbers, user codes, file names.

A resource type is recognized from the list of every resource type FHIR R4, R4B and R5 define (`telemetry-core`'s `fhir-resource-types.ts`), so a capitalized name or user id (`/users/Johnsmith`) is not kept for looking like one. The rules err towards replacing too much: a segment after a resource type becomes `{id}`, so an id that happens to be a resource type's name costs the next segment its name rather than letting the id after it through. What still passes is an id shaped like a lowercase route word where no resource type precedes it, such as `john-smith` in a route the app names its records by.

The same pass covers free text: the event's message and `logentry` (its message and string parameters), each exception's message, and each breadcrumb's message have the URLs in them anonymized like span descriptions, so `Failed to fetch dynamically imported module: https://ruth.example/assets/Chart-abc.js` reports `https://{host}/assets/{id}`. A URL is read without the brackets, quotes and sentence punctuation around it, which stay, so `(https://wildflowerhealth.io/servers).` stays as written. Any other word with a `/`, `?` or `#` in it is read as a path too, which errs towards replacing too much: `Invalid date 10/15/2026` reports `Invalid date {id}/{id}/{id}`, since a date in a message can be a birth date.

## Server hosts are replaced wherever they stand

A stack frame names the script it ran in by URL, and an app served from a user's server or relay tunnel loads its scripts from that server: `https://android-emu.relay.wildflowerhealth.io/assets/index-abc.js`. `scrubEvent` replaces only the host in each frame's `filename`, `abs_path` and `module`, and in each debug image's `code_file`, with `{host}`, keeping the path and file name: `https://{host}/assets/index-abc.js`. Running these through `anonymizeUrl` would turn the bundle's file name into `{id}`. A long animation frame span's `code.filepath` and `browser.script.invoker`, which name the script it blames, are reported the same way, with the script URL's query string and fragment dropped as well.

A server's host can also stand outside any URL: `Could not reach ruth.example:8443`, a console breadcrumb's arguments, a React component stack in `extra` or contexts. After the URL pass, `scrubEvent` replaces the same hosts with `{host}` in the message and `logentry`, exception messages, breadcrumb messages, every string in breadcrumb and span data that is not already a URL or host attribute, span descriptions, the transaction name, tags, `extra` and contexts, at any depth, in object keys as well as values.

Source maps still resolve. The site's builds carry debug IDs (see below), and the SDK lists each script a frame ran in as a debug image, with the frame's path as its `code_file` and the script's debug ID. Sentry pairs a frame with its image by that path and finds the map by the debug ID, never by URL; the frame and the image are rewritten alike, so the pairing holds.

The hosts replaced are matched case-insensitively, with any port and any subdomains in front, on label boundaries (`ruth.example` does not match `xruth.example` or `ruth.examples`), by `telemetry-core`'s `makeHostRedactor`. A single-label host such as a docker-compose service name (`fhir`) is an ordinary word too, so it is replaced only where it reads as a host: at the start of a URL's authority (`http://fhir:8080/x`, `user@fhir`) or with a port (`fhir:8080`); the word alone (`FHIR R4`) and identifiers built on it (`fhir_server_host`) stay. A dot after the host ends it, so `ruth.example.status` reports `{host}.status`, and so does a longer host such as `ruth.example.org`. A match also starts right after an escape, so a host in a percent-encoded URL (`iss=https%3A%2F%2Fruth.example`, encoded once or more) or after a backslash escape (`\nruth.example`) is replaced too. The hosts are:

- every relay tunnel, `*.relay.wildflowerhealth.io` at any depth;
- the page's own host;
- the hosts the app has learnt at run time through `telemetry-web`'s `redactServerHost`: `setFhirServerHost` passes the FHIR server's host; the launcher passes the server a page load signs in to, was opened for or is pointed at, and each server the landing signs in to; and the Tauri host's base passes each server's domain each time it reads the server list, the hosts typed into Add server's relay settings before it adds the server, and the added server's domain once it is added. A SMART app's FHIR server URL that does not parse is passed as written, which redacts a bare hostname; a value that names no host, such as a path (`/fhir`), is ignored.

`telemetry-web` builds the redactor once and rebuilds it only when `redactServerHost` learns a new host.

Kept hosts (`localhost`, `tauri.localhost`, `wildflowerhealth.io`) stay as written.

## Consent lives in the origin's storage

The answer is one versioned record in `localStorage` under `wildflower.telemetry-consent`, holding both switches, the copy version of the dialog that was answered, and when. Storage is per origin, so every app served from one origin shares one answer, and a dev server on its own port asks on its own.

A record whose version is not the app's current copy version reads as undecided, as does a record that does not decode: changing what the dialog says re-asks everyone, and a corrupt record is replaced by the next answer rather than guessed at.

## The dialog comes first

`TelemetryConsentGate` wraps an app and renders nothing of it until the visitor has answered: while no answer for the current copy version is stored, the page is the consent dialog alone, so no app code runs, fetches or reports before the visitor has said what may be sent. A stored current answer skips the dialog and renders the app at once.

The dialog is react-tundraish's non-dismissable `Dialog`. It has no close button, and the backdrop and Escape do nothing; if the browser closes it anyway (Chrome does on a second Escape where `closedby="none"` is unsupported), it shows itself again with the switches as the visitor left them. It leads with the early-stage warning (the code is unaudited, use your own judgement, here is the repository), says where reports go, and offers the two switches, both off, each described by what it sends. It then says that the answer can be changed later, gives the as-is disclaimer at body size, and ends on the acceptance sentence — "By continuing you accept the Terms of use and acknowledge the Privacy policy", each linked to its page on the marketing site — right above the one **Continue** button, so pressing Continue is the visitor's agreement to the terms. The warning also carries the medical disclaimer: nothing in Wildflower is medical advice. Continue with both switches off is an answer like any other and reveals the app.

The gate reads and writes the answer through `useTelemetryConsent`, which reads storage once on mount and, on Continue, stamps the switches with the copy version and the time and writes them back. Either way the gate calls its `onDecided` with the answer, from a layout effect, so it runs before any of the app's own effects, and the app passes that to `initConsentedTelemetry`. The words, and the copy version the answer is stored with, are `TELEMETRY_CONSENT_COPY` in `branding-core`, so rewording the dialog and raising its version are one edit.

Inside the gate, `useTelemetryConsentControls` gives app chrome the answer, the gate's copy and a `reopen` function. `TelemetryStatusControl` reads the answer out ("Telemetry: Crash reports on · Performance data off") and reopens the dialog when pressed; the dialog then opens over the mounted app with the switches set to the current answer, and Continue replaces it and calls `onDecided` again.

## Nothing starts before a yes

Some apps deliberately send nothing but FHIR traffic from the browser. A filter applied at send time would still load and run the SDK, patch `fetch` and the console, and collect breadcrumbs before discarding them; so consent gates initialization itself. `initConsentedTelemetry` narrows the build's config with `telemetryConfigFor` first, and an undecided or declined answer leaves no sink in it, so the SDK is never initialized. A yes initializes it once per page load. The app calls `initConsentedTelemetry` again whenever the answer changes, and the SDK's hooks follow the latest answer: a switch turned off stops its events at once, and crash reports turned on start at once. Performance is the exception. If the SDK started with crash reports only, turning performance on later sends nothing until the next page load: `Sentry.init` fixes trace sampling, and `sentryOptionsFor` in `consented.ts` adds browser tracing only when the first answer has performance on.

## Per-app projects and tags

Each app reports to its own Sentry project, so the app hands `useConsentedTelemetryStart` that project's DSN, which it reads from its own build variable: `VITE_SENTRY_DSN_MEDICATIONS_WEB`, `VITE_SENTRY_DSN_IMPORTER_WEB`, `VITE_SENTRY_DSN_PLOTS_WEB`, `VITE_SENTRY_DSN_STRENGTH_WEB`, `VITE_SENTRY_DSN_FHIR_SYNC_PEBBLE_WEB` and `VITE_SENTRY_DSN_SYNTHETIC_DATA_WEB` for the SMART apps, `VITE_SENTRY_DSN_LAUNCHER_WEB` for the launcher, `VITE_SENTRY_DSN_AUTHORIZATION_WEB` for Wildflower Authorization, and `VITE_SENTRY_DSN_HOST_APP` for the Tauri host's base, each named in the app's `.env.example`. The hook puts the DSN into the build's config (`configFromViteEnv`) and names the OpenTelemetry service after the app, so the shared `VITE_SENTRY_DSN` never stands in for an app's own, even an empty one. DSNs are public identifiers, not credentials, so they are build variables rather than secrets. Environment and release come from the build as well (`VITE_SENTRY_ENVIRONMENT`, `VITE_SENTRY_RELEASE`, read by `telemetry-web`'s `configFromViteEnv`), and a build that sets no DSN reports nothing whatever the answer.

The site deploys (`deploy-github-pages.yml` for `production`, `pr-preview.yml` for `staging`) set the release to the commit SHA and register it in Sentry with the apps' source maps, through the `.github/actions/sentry-sourcemaps` composite action and `getsentry/action-release`. The deploys pass every app's DSN variable except web-trace's, so the deployed web-trace reports nothing. Each of the other apps builds with `sourcemap: 'hidden'`, so the maps are emitted but the bundle never references them. The action injects debug IDs into the assembled site's JavaScript and maps, so a stack trace finds its map by ID rather than by URL. The action takes each project's numeric ID from the end of its DSN, and skips an app whose DSN variable is empty. It uploads the maps to every one of those projects and then deletes them, so the site never serves the original source. The upload needs the `SENTRY_AUTH_TOKEN` secret (a Sentry organization auth token, whose `org:ci` scope covers releases and source maps) and the `SENTRY_ORG` variable. Without the token the deploy skips the upload and still deletes the maps.

Every event carries tags set on the SDK's global scope: `app` (the app's id); in the SMART apps `launch` (`launching` on the launch page that authorizes a launch the URL carries, `standalone` on the connect page, `launched` in the app a completed SMART launch opened; an EHR launch and a standalone one return to the same page with the same callback, so the tag does not tell them apart) and `fhir_server_host`, set with `setFhirServerHost` once the app knows which FHIR server it is connected to; in the launcher `entry` (`main-web`).

`fhir_server_host` carries the host reduced by `anonymizeHost`, so it says what kind of server the app reached without naming it: `localhost:8080` for a kept host, `{host}` for any other, `{empty}` for an empty host (Sentry drops a tag whose value is empty), and `{null}` when the FHIR server URL has no host to read. An event from before the handshake completes has no `fhir_server_host` tag at all.

## The SMART apps

The SMART apps get all of this from `smart-app-react`'s `SmartAppRoot`, which takes the app's DSN and id as its `telemetry` prop. The gate wraps both of its branches, so the consent dialog comes before the connect page and before the launched app. On an answer it starts telemetry through `useConsentedTelemetryStart`; once Sentry runs it tags the FHIR server's host when the app's SMART handshake completes, and reports the launch failure the page arrived with (`source: launch-error`) from the hook's `onFirstStart`, so once. A `CrashReportingBoundary` around the launched app and another around the connect menu report render crashes, and the query cache of the page's one `QueryClient` reports failed reads (`source: query`), through `Sentry.captureException`, which does nothing while the SDK has not been initialized. A failed SMART handshake is not reported as a failed read: the app sends it back to the connect page, where it is reported as the launch failure the page arrived with. A FHIR server URL that does not parse is reported (`source: fhir-server-host`), without the URL, which no scrubbing would recognize as one, and tagged `{null}`. The status control sits at the end of the brand bar in the launched app and above the footer on the connect page.

The apps keep the plain `FetchHttpClient.layer`.

## The launcher

`apps/launcher/launcher-web`'s web entry (`main-web`, the launcher published at `/launcher/`) asks first, like the SMART apps.

It mounts `ConsentedEntryRoot`, which puts the whole app behind the gate: until the user answers, the page is the dialog alone, so no sign-in is redeemed and no router, query client, transport or Effect runtime exists. The answer, stored or new, starts telemetry through `useConsentedTelemetryStart` (tags `app: launcher-web` and `entry`) and only then boots the app, once: a stored yes has Sentry and the tracer provider running before the router is built. While the boot runs (on a return leg, it redeems the sign-in over the network), the page shows the brand bar over a loading line. A `CrashReportingBoundary` reports a boot that fails. The answer is kept in the page's `localStorage`. On the published site the launcher shares its origin with the SMART apps, so a visitor who answered in one of them is not asked again.

The app's Effect runtime carries `telemetry-web`'s `consentedTelemetryLayer`, which is empty until an answer registers the tracer provider, and re-read each time a request builds the runtime, so Effect's spans go to Sentry from the first request after a yes turns performance on and stop with the first after it is turned off. The app's existing `Sentry.captureException` and `Sentry.addBreadcrumb` calls do nothing until then. The answer is changed from the Telemetry row in settings, which reads it out by the gate's copy and reopens the dialog.

## The Tauri host's base

The desktop and mobile host's webview (`apps/host/host-app`) asks first in the same way, through the base's gate, `servers-react`'s `BaseGate`: a `TelemetryConsentGate` around the app's router, so until the user answers no query cache exists and no host command is called. The webview has an origin of its own, and shows `WILDFLOWER_HOST_TELEMETRY_CONSENT_COPY`: the same switches, worded for an app that keeps what it loads on the device and is changed from Host Settings. The answer starts telemetry through `useConsentedTelemetryStart` with `VITE_SENTRY_DSN_HOST_APP` (tag `app: host-app`). Its query cache reports failed host commands (`source: query`), a `CrashReportingBoundary` reports a screen that crashes, and the base's Host Settings has the Telemetry row that reopens the dialog.
