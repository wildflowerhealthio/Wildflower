import "./instrument.ts";
import { createServer } from "node:http";
import { HttpApi, HttpApiBuilder, HttpApiSwagger, HttpMiddleware } from "@effect/platform";
import { NodeHttpServer, NodeRuntime } from "@effect/platform-node";
import { Effect, Layer, pipe } from "effect";
import { makeLivestoreStoreLayer } from "emr-core/contexts";
import { FhirPublicApi, FhirResourcesApi } from "fhir-r4/http-api-definition";
import {
  FhirPublicApiHandlersFor,
  FhirResourcesApiHandlersFor,
  SmartConfigurationLive,
} from "fhir-r4/http-api-implementation";
import {
  makeGatekeeperStoreLayer,
  mintHostOwnerToken,
  seedFirstPartyClient,
} from "gatekeeper-core/contexts";
import { GatekeeperApi } from "gatekeeper-core/http-api-definition";
import {
  GatekeeperApiHandlersFor,
  RequireAuthMiddleware,
  RequireAuthMiddlewareLive,
} from "gatekeeper-core/http-api-implementation";
import { Origin } from "kitchen-sink";
import { CryptoRandomLayerLive } from "kitchen-sink/crypto-random";
import { createStore } from "./LivestoreStore.ts";
import { StaticSpaLive } from "./static-spa.ts";
import { TelemetryLive } from "./telemetry.ts";

const PORT = 3000;
const ORIGIN = `http://localhost:${PORT}`;

const corsMiddleware = HttpMiddleware.cors({
  allowedOrigins: ["*"],
  allowedMethods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
  allowedHeaders: [
    "Content-Type",
    "Authorization",
    "origin",
    "accept",
    "x-requested-with",
    "traceparent",
    "tracestate",
    "baggage",
    "sentry-trace",
  ],
});

const WildflowerNodeApi = HttpApi.make("WildflowerNodeApi")
  .addHttpApi(GatekeeperApi)
  .addHttpApi(FhirResourcesApi.middleware(RequireAuthMiddleware))
  .addHttpApi(FhirPublicApi);

const CryptoRandomLive = CryptoRandomLayerLive<
  Uint8Array & ReturnType<typeof globalThis.crypto.getRandomValues>
>(globalThis.crypto, new Uint8Array(1));

const run = Effect.gen(function* () {
  const store = yield* Effect.promise(() => createStore());

  // Boot-time bootstrap: register the first-party host client (idempotent)
  // and mint an Owner token for it. The token is appended to the printed
  // server URL via `?token=` so an operator who opens the URL lands in the
  // SPA already authenticated; `gatekeeper-web/host-token-bootstrap`
  // consumes the param and strips it from the address bar.
  const bootstrapToken = yield* Effect.gen(function* () {
    yield* seedFirstPartyClient;
    return yield* mintHostOwnerToken();
  }).pipe(
    Effect.provide(makeGatekeeperStoreLayer(store)),
    Effect.provide(Layer.succeed(Origin, ORIGIN)),
    Effect.catchAll((err) =>
      pipe(Effect.logError("Error generating auth token", err), Effect.as("TOKEN_ERROR")),
    ),
  );

  const WildflowerNodeApiLive = HttpApiBuilder.api(WildflowerNodeApi).pipe(
    Layer.provide(GatekeeperApiHandlersFor<"WildflowerNodeApi">()),
    Layer.provide(FhirResourcesApiHandlersFor<"WildflowerNodeApi">()),
    Layer.provide(FhirPublicApiHandlersFor<"WildflowerNodeApi">()),
    Layer.provide(RequireAuthMiddlewareLive),
    Layer.provide(SmartConfigurationLive),
    Layer.provide(makeLivestoreStoreLayer(store)),
    Layer.provide(makeGatekeeperStoreLayer(store)),
    Layer.provide(CryptoRandomLive),
  );

  const ServerLive = HttpApiBuilder.serve(corsMiddleware).pipe(
    Layer.provide(HttpApiSwagger.layer()),
    Layer.provide(WildflowerNodeApiLive),
    Layer.provide(StaticSpaLive),
    Layer.provide(NodeHttpServer.layer(createServer, { port: PORT })),
    Layer.provide(Layer.succeed(Origin, ORIGIN)),
    Layer.provide(TelemetryLive),
  );

  const bootstrapUrl = `${ORIGIN}/gatekeeper?token=${encodeURIComponent(bootstrapToken)}`;
  yield* Effect.logInfo(`Server is running. Bootstrap: ${bootstrapUrl}`);
  yield* Layer.launch(ServerLive);
});

NodeRuntime.runMain(run);
