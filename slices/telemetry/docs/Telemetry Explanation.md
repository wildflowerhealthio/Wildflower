# Telemetry Explanation

How a Wildflower web app decides what, if anything, it reports to Sentry, and why nothing is reported before the visitor says yes.

The consent model, the URL anonymizer and the event scrubber are pure functions in `telemetry-core` (`consent.ts`, `anonymize-url.ts`, `scrub-event.ts`, `consented-config.ts`); `telemetry-web`'s `initConsentedTelemetry` (`consented.ts`) applies them to the Sentry browser SDK.

## Two switches, both off

The visitor answers two independent questions, and each is an opt-in:

- **Crash reports** send errors: the exception, its stack, and the breadcrumbs leading up to it. An error can carry whatever data the app had loaded, so this switch is the one that may send record contents. The apps are demos meant for synthetic or test data, and the dialog says so.
- **Performance** sends page loads, request timings and route names through Sentry's browser tracing, sampled at the build's `tracesSampleRate`, together with the app's own OpenTelemetry spans, which reach Sentry through its span processor. It sends no record contents.

Both switches report to the same Sentry project, so the DSN stays while either is on. With only performance on, the SDK's `beforeSend` hook drops every error event; with only crash reports on, the trace sample rate is 0 and `beforeSendTransaction` drops every transaction. Profiling and session replay belong to neither switch, so they never run. The dialog names Sentry as where reports go, so no answer turns on the OTLP exporter, whose spans would pass no scrubbing hook. The SDK's `dataCollection` is turned off for user fields, cookies, headers, bodies and query parameters whatever the answer.

## URLs are reduced to their shape

Every event either switch sends passes through `scrubEvent`, which runs each URL it carries (the request URL and `Referer`, fetch and navigation breadcrumbs, span attributes such as `url.full`, `url.path` and `lcp.url`, span descriptions, the transaction name) through `anonymizeUrl`, and drops the span attributes that carry a query string, a fragment or an HTTP header. `anonymizeUrl` keeps the origin and the FHIR base path, drops the query string, fragment and credentials, and replaces the segment after a resource type with `{id}` and the segment after `_history` with `{vid}`. Relative references keep their form, so `Observation?patient=1` becomes `Observation`:

```text
https://fhir.example/r4/Patient/123/_history/2?_format=json
https://fhir.example/r4/Patient/{id}/_history/{vid}
```

A resource type is recognized by shape (an uppercase then a lowercase letter, letters only), not from a list. The rule errs towards replacing too much: a segment after anything shaped like a resource type becomes `{id}`, so an id that happens to look like one costs the next segment its name rather than letting the id after it through.

## Consent lives in the origin's storage

The answer is one versioned record in `localStorage` under `wildflower.telemetry-consent`, holding both switches, the copy version of the dialog that was answered, and when. Storage is per origin, so every app served from one origin shares one answer, and a dev server on its own port asks on its own.

A record whose version is not the app's current copy version reads as undecided, as does a record that does not decode: changing what the dialog says re-asks everyone, and a corrupt record is replaced by the next answer rather than guessed at.

## Nothing starts before a yes

Some apps deliberately send nothing but FHIR traffic from the browser. A filter applied at send time would still load and run the SDK, patch `fetch` and the console, and collect breadcrumbs before discarding them; so consent gates initialization itself. `initConsentedTelemetry` narrows the build's config with `telemetryConfigFor` first, and an undecided or declined answer leaves no sink in it, so the SDK is never initialized. A yes initializes it once per page load. The app calls `initConsentedTelemetry` again whenever the answer changes, and the SDK's hooks follow the latest answer: a switch turned off stops its events at once, and crash reports turned on start at once. Performance turned on after the SDK started without it takes effect on the next load, since browser tracing is added only when the SDK starts.

## Per-app projects and tags

Each app reports to its own Sentry project, so the app hands `initConsentedTelemetry` a config carrying that project's DSN, which it reads from its own `VITE_SENTRY_DSN_<APP>` build variable. DSNs are public identifiers, not credentials, so they are build variables rather than secrets. Environment and release come from the build as well.

Every event carries tags set on the SDK's global scope: `app` (the app's id), `launch` (`standalone` through the connect menu, `ehr` through an EHR launch), and `fhir_server_host`, set with `setFhirServerHost` once the app knows which FHIR server it is connected to.
