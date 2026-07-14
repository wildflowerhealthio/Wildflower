import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from '@effect/platform'
import {
  AppIdPathSchema,
  AppListSchema,
  AppNotEditableSchema,
  AppNotFoundSchema,
  CloudAppBodySchema,
  CloudAppDetailSchema,
  CreateSelfHostedAppBodySchema,
  HomeScreenSchema,
  InvalidFieldSchema,
  InvalidHomeScreenSchema,
  SelfHostedAppBodySchema,
  SelfHostedAppDetailSchema,
  SystemAppDetailSchema,
} from './schemas.ts'

/**
 * Owner-only mutations + per-kind detail reads on the apps catalogue. The group
 * itself carries no middleware — `wildflower-server` (or any other composing app)
 * applies `RequireAuthMiddleware` when adding `AppsAdminApi` to its root
 * `HttpApi`, so slice cores stay free of auth dependencies.
 *
 * Per-kind detail/create/replace live on their own root resources (`/cloud-apps`,
 * `/self-hosted-apps`, `/system-apps`), each returning the flat per-kind detail
 * shape; `DELETE /apps/:id` removes any kind (204); `PUT /home-screen` atomically
 * reorders / enables every kind. A per-kind path given an id of another kind is a
 * `404`. See `docs/Apps/Explanation.md` and the per-endpoint schemas.
 */
const httpApiGroup = HttpApiGroup.make('apps-admin', { topLevel: false })
  // --- Cloud apps ---------------------------------------------------------
  .add(
    // Create a cloud app from a JSON body ({@link CloudAppBodySchema}).
    HttpApiEndpoint.post('CreateCloudApp', '/cloud-apps')
      .setPayload(CloudAppBodySchema)
      .addSuccess(CloudAppDetailSchema)
      .addError(InvalidFieldSchema, { status: 400 })
  )
  .add(
    HttpApiEndpoint.get('GetCloudApp', '/cloud-apps/:id')
      .setPath(AppIdPathSchema)
      .addSuccess(CloudAppDetailSchema)
      .addError(AppNotFoundSchema, { status: 404 })
  )
  .add(
    // Full-replace a cloud app's content; a non-cloud id is `404`.
    HttpApiEndpoint.put('ReplaceCloudApp', '/cloud-apps/:id')
      .setPath(AppIdPathSchema)
      .setPayload(CloudAppBodySchema)
      .addSuccess(CloudAppDetailSchema)
      .addError(InvalidFieldSchema, { status: 400 })
      .addError(AppNotFoundSchema, { status: 404 })
  )
  // --- Self-hosted apps ---------------------------------------------------
  .add(
    // Install a self-hosted app from an uploaded zip — `multipart/form-data`
    // ({@link CreateSelfHostedAppBodySchema}). A multipart endpoint's typed client
    // payload is a `FormData` instance.
    HttpApiEndpoint.post('CreateSelfHostedApp', '/self-hosted-apps')
      .setPayload(CreateSelfHostedAppBodySchema)
      .addSuccess(SelfHostedAppDetailSchema)
      .addError(InvalidFieldSchema, { status: 400 })
  )
  .add(
    HttpApiEndpoint.get('GetSelfHostedApp', '/self-hosted-apps/:id')
      .setPath(AppIdPathSchema)
      .addSuccess(SelfHostedAppDetailSchema)
      .addError(AppNotFoundSchema, { status: 404 })
  )
  .add(
    // Replace a self-hosted app's launch path; a non-self-hosted id is `404`, a
    // seeded app is `409`.
    HttpApiEndpoint.put('ReplaceSelfHostedApp', '/self-hosted-apps/:id')
      .setPath(AppIdPathSchema)
      .setPayload(SelfHostedAppBodySchema)
      .addSuccess(SelfHostedAppDetailSchema)
      .addError(InvalidFieldSchema, { status: 400 })
      .addError(AppNotFoundSchema, { status: 404 })
      .addError(AppNotEditableSchema, { status: 409 })
  )
  // --- System apps (read-only) -------------------------------------------
  .add(
    HttpApiEndpoint.get('GetSystemApp', '/system-apps/:id')
      .setPath(AppIdPathSchema)
      .addSuccess(SystemAppDetailSchema)
      .addError(AppNotFoundSchema, { status: 404 })
  )
  // --- Unified delete + homescreen ---------------------------------------
  .add(
    // Delete any app (kind resolved via the registration). `204` on success; a
    // system / seeded self-hosted app is `409`.
    HttpApiEndpoint.del('DeleteApp', '/apps/:id')
      .setPath(AppIdPathSchema)
      .addSuccess(HttpApiSchema.NoContent)
      .addError(AppNotFoundSchema, { status: 404 })
      .addError(AppNotEditableSchema, { status: 409 })
  )
  .add(
    // The full ordered homescreen (all kinds), distinct from the per-kind content
    // edits above — see {@link HomeScreenSchema}.
    HttpApiEndpoint.put('ReplaceHomeScreen', '/home-screen')
      .setPayload(HomeScreenSchema)
      .addSuccess(AppListSchema)
      .addError(InvalidHomeScreenSchema, { status: 400 })
  )

export { httpApiGroup }
