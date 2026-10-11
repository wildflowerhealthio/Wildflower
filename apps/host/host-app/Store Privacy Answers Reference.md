# Store Privacy Answers Reference

What to enter in Google Play's **Data safety** form and App Store Connect's **App Privacy** section for Wildflower Host. The answers follow the [privacy policy](https://wildflowerhealth.io/privacy-policy/) and the code behind it: change them together.

## What the app sends

Wildflower Host's webview runs the Sentry browser SDK. It is off until the person turns a switch on in the consent dialog (`WILDFLOWER_HOST_TELEMETRY_CONSENT_COPY` in `branding-core`).

| Switch           | Sends                                                                           | Can carry health data |
| ---------------- | ------------------------------------------------------------------------------- | --------------------- |
| Crash reports    | Error reports, with anything the app had loaded                                 | Yes                   |
| Performance data | Page and request timings, page and resource-type names, ids and queries removed | No                    |
| Either switch    | Session counts: opened, errored, operating system                               | No                    |

`PERSONAL_DATA_OFF` (`telemetry-web/src/consented.ts`) sends no user fields, cookies, headers, bodies or query parameters. The Sentry organisation is set not to store IP addresses. Sentry deletes events after 90 days.

Nothing else leaves the device for the developer:

- Records loaded into Host stay on the device.
- Web apps reach the device's server through the relay, end-to-end encrypted to a certificate held on the device. The relay can't read the traffic.
- The certificate request to Let's Encrypt carries only the tunnel's domain, with no contact.
- The relay's tunnel email is entered by the relay's administrator, not collected by the app.

## Google Play: Data safety

| Question                                                              | Answer                                        |
| --------------------------------------------------------------------- | --------------------------------------------- |
| Does your app collect or share any of the required user data types?   | Yes                                           |
| Is all of the user data collected by your app encrypted in transit?   | Yes (HTTPS to Sentry)                         |
| Do you provide a way for users to request that their data is deleted? | Yes: `https://wildflowerhealth.io/deletion/`  |
| Privacy policy URL                                                    | `https://wildflowerhealth.io/privacy-policy/` |

Data types. Each one is **collected**, **not shared** (Sentry is a service provider), **not processed ephemerally**, and **optional**: users can choose whether it is collected.

| Category                 | Data type   | Purpose   |
| ------------------------ | ----------- | --------- |
| Health and fitness       | Health info | Analytics |
| App info and performance | Crash logs  | Analytics |
| App info and performance | Diagnostics | Analytics |

Leave every other data type unchecked: no location, personal info, identifiers, contacts, files or activity.

## App Store Connect: App Privacy

| Question                           | Answer |
| ---------------------------------- | ------ |
| Do you collect data from this app? | Yes    |

Data types. For each: **not linked to the user's identity**, **not used for tracking**, purpose **App Functionality** (Apple's definition includes minimising crashes and improving performance).

| Category         | Data type             |
| ---------------- | --------------------- |
| Health & Fitness | Health                |
| Diagnostics      | Crash Data            |
| Diagnostics      | Performance Data      |
| Diagnostics      | Other Diagnostic Data |

The iOS privacy manifest, `src-tauri/gen/apple/PrivacyInfo.xcprivacy`, declares the same four types, no tracking and no tracking domains. Keep it in step with this table.
