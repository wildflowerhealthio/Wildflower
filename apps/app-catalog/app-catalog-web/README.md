# app-catalog-web

Wildflower's App Catalog, published at
`https://app-catalog.wildflowerhealth.io/`: the SMART on FHIR apps worth
trying with a Wildflower server, as a
[HALO 1.2 App Catalog](https://simplifier.net/guide/halo/Home/HALO-Components/App-Catalog?version=1.2.0-dft-preballot).
`GET /apps` answers the whole catalog, a JSON array of HALO application
objects whose schema is `app-catalog-core-js`'s `AppCatalog.Catalog`.

## The catalog file

`public/apps.json` is the catalog, hand-edited. The build serves it at two
paths with the same bytes:

- **`/apps`**, the path HALO names. GitHub Pages picks a file's content type
  from its extension, so it serves this one as `application/octet-stream`,
  with `access-control-allow-origin: *`.
- **`/apps.json`**, which Pages serves as `application/json`, for a client
  that checks the type.

Vite copies `public/apps.json` into `dist/`, and `scripts/write-catalog.ts`,
the build's last step, copies it to `dist/apps`.

The catalog is in one language. A static site cannot negotiate
`Accept-Language` or send `Content-Language`, so every entry is
`lang: "en-CA"` and none carries `langSupported`, which HALO asks for only
from a catalog with a second language.

## Adding an app

1. Mint the app's id once, with `uuidgen`, and never change it.
2. Add the entry to `public/apps.json`. A Wildflower app takes the Wildflower
   Health publisher and contacts the other entries carry, its menu name from
   `branding-core`'s `HEADER_NAV_GROUPS` as `name`, its `APP_DESCRIPTIONS`
   tagline as `descriptionShort` and paragraphs (joined by a space) as
   `description`, its landing page as `helpUrl`, and the site's privacy
   policy and terms. Its OAuth client goes in `preassignedCredentials`,
   copied field for field from the row the authorization server's migrations
   seed, with `registrationModes: ["preassigned"]`. `eligibilityCriteria`
   says who the app is for, naming the resources it reads in parentheses
   rather than FHIR or Wildflower.
3. Run the tests that hold it: `vp test` here (`src/catalog.test.ts` decodes
   the file and checks each Wildflower app against `branding-core`), and
   `cargo test -p wildflowerhealthio-authorization-server
   app_catalog_preassigns_the_seeded_first_party_clients`, which checks each
   `preassignedCredentials` and `launchUrl` against the seeded client.

## The page

`index.html` is the site's page: the shared site header and footer
(`branding-react`) around a link to the catalog. `src/main.tsx` restores a
GitHub Pages 404 redirect before anything else reads the URL.
