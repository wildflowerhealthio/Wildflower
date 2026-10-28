# app-catalog-web

Wildflower's App Catalog, published at
`https://app-catalog.wildflowerhealth.io/`: the SMART on FHIR apps worth
trying with a Wildflower server, as a
[HALO 2.0.0-DFT-preBallot App Catalog](https://simplifier.net/guide/halo/Home/HALO-Components/App-Catalog).
`GET /apps` answers the whole catalog, a JSON array of HALO application
objects whose schema is `app-catalog-core-js`'s `AppCatalog.Catalog`. Every
entry is a `smart-app`.

## The catalog file

`public/apps.json` is the catalog, hand-edited, each entry's fields in the
order the spec lists them. Vite copies it into `dist/`, and
`scripts/write-catalog.ts`, the build's last step, copies it to `dist/apps`.

## Where a static catalog falls short of HALO

The catalog is a file on GitHub Pages, not a server, so two of HALO's
expectations go unmet:

- **One language.** HALO expects a catalog in English and French, chosen by
  the client's `Accept-Language` and labelled with a `Content-Language`
  header. A static file cannot negotiate and sends no `Content-Language`, so
  every entry is in one language, `contentLanguage: "en-CA"`.
- **`/apps` is served as `application/octet-stream`.** Pages picks a file's
  content type from its extension, so the extensionless path HALO names goes
  out as octet-stream (with `access-control-allow-origin: *`). `/apps.json`
  carries the same bytes as `application/json`, for a client that checks the
  type.

## Adding an app

1. Mint the app's id once, with `uuidgen`, and never change it.
2. Add the entry to `public/apps.json`. A Wildflower app takes the Wildflower
   Health publisher and contacts the other entries carry, its menu name from
   `branding-core`'s `HEADER_NAV_GROUPS` as `name`, its `APP_DESCRIPTIONS`
   tagline as `descriptionShort` and paragraphs (joined by a space) as
   `description`, its landing page as `helpUrl`, and the site's privacy
   policy and terms, with `type: "smart-app"` and `contentLanguage: "en-CA"`.
   Its OAuth client goes in `preassignedCredentials`,
   copied field for field from the row the authorization server's migrations
   seed, with `registrationModes: ["preassigned"]`. `eligibilityCriteria`
   says who the app is for, naming the resources it reads in parentheses
   rather than FHIR or Wildflower.
3. Run the tests that hold it: `vp test` here (`src/catalog.test.ts` decodes
   the file and checks each Wildflower app against `branding-core`), and
   `cargo test -p wildflowerhealthio-authorization-server
   app_catalog_preassigns_wildflower_health_clients_as_seeded`, which checks each
   `preassignedCredentials` and `launchUrl` against the seeded client.

## The page

`index.html` is the site's page: the shared site header and footer
(`branding-react`) around a link to the catalog. `src/main.tsx` restores a
GitHub Pages 404 redirect before anything else reads the URL.
