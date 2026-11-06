---
name: 'typescript-client-initialization'
description: 'Construct and configure the PayPal Server SDK TypeScript SDK client. Load before you call `new Client({...})` or wire the client into an application. The type won''t tell you the configuration is one flat options object, that you instantiate controllers yourself, or which generated factory throws for every input.'
---

# Initializing an APIMatic-generated TypeScript SDK client

Package and type names below are concrete for this SDK; replace the remaining `{...}` placeholders with
the real names from its source:

- `{Controller}` — a controller class exported from the package root. Its postfix (`Api`, `Controller`,
  …) is the SDK's controller-naming setting, fixed at generation time; read the real `export class`
  names in `src/controllers/` rather than assuming either.

## The shape: one options object, no builder

The SDK exports a single `Client` class. You construct it with **one options object**, a
`Partial<Configuration>` — every field is optional and missing fields fall back to `DEFAULT_CONFIGURATION`:

```ts
import { Client, Environment } from '@paypal/paypal-server-sdk';

const client = new Client({
  environment: Environment.{Name},
  // auth credential objects — see typescript-authentication
  timeout: 30000,                  // ms; 0 disables the timeout
  httpClientOptions: {             // retries, proxy, agents — see typescript-configuration-resilience
    // ...
  },
});
```

There is **no** separate options class or builder — the `Configuration` interface *is* the constructor
argument. Open `src/configuration.ts` for the exact field set; it varies per API but always includes
`timeout`, `environment`, `httpClientOptions`, plus the credential objects for the schemes the API uses
(and any server parameters such as `port`). `src/defaultConfiguration.ts` holds `DEFAULT_CONFIGURATION`
(the field defaults) and `DEFAULT_RETRY_CONFIG`.

## Choosing the environment / base URL

Environments are members of an `enum Environment` in `src/configuration.ts`. **Read the enum for the
real member names before naming one.**

Do not assume a particular member exists — there may
be no `Production` at all. A name also does **not** imply a live host: match each member to the base URL
it actually resolves to in `src/client.ts`, not to what its name suggests.

The base URL is **derived** from the selected environment (plus any server parameters like `port`) by the
`getBaseUri` resolver in `src/client.ts`. The default environment
is whatever `DEFAULT_CONFIGURATION.environment` sets.

An SDK may also declare several **named servers** (a `Server` union in `src/clientInterface.ts`).
`getBaseUri(server, config)` maps each *(environment, server)* pair to its own host, and each operation
picks its server itself via `req.baseUrl(...)` in `src/controllers/` — which is why, say, an OAuth token
call can go to a different host than the resource calls. Selecting an `Environment` switches all of them
together; there is **no** per-server or per-operation configuration knob.

```ts
const client = new Client({ environment: Environment.{Name} });
```

Some SDKs expose server parameters (e.g. `port`, or a template variable) as their own `Configuration`
fields that feed the base-URL template. To point the SDK at a mock or proxy that the `Environment`
members don't cover, see **typescript-configuration-resilience** and **typescript-testing**. Inspect the
`getBaseUri`/base-URL function in `src/client.ts` for the exact environments and server parameters.

## Custom HTTP options — timeout, proxy, agents, retries

Transport tuning lives under the nested `httpClientOptions` (a `Partial<HttpClientOptions>`). The common
fields (confirm in `doc/http-client-options.md`):

| Field | Type | Purpose |
| --- | --- | --- |
| `timeout` | `number` | per-request timeout in **milliseconds** (overrides the top-level `timeout`) |
| `retryConfig` | `Partial<RetryConfiguration>` | retry policy — defaults are baked in at generation time; read `DEFAULT_RETRY_CONFIG` in `src/defaultConfiguration.ts`. See typescript-configuration-resilience |
| `proxySettings` | `ProxySettings` | route requests through a proxy |
| `httpAgent` / `httpsAgent` | `any` | custom Node http(s) agents (keep-alive, TLS) |

```ts
const client = new Client({
  httpClientOptions: {
    timeout: 30000,
    retryConfig: { maxNumberOfRetries: 3, backoffFactor: 2 },
  },
});
```

There is also an escape hatch, `unstable_httpClientOptions` (`any`), passed straight to the underlying
axios adapter — and it is the seam for injecting a fake client in tests (see **typescript-testing**).

## Configuration from environment variables / JSON

A static factory builds a client without writing the options object by hand:

```ts
const client = Client.fromEnvironment();            // reads process.env (or pass an object)
```

`fromEnvironment` reads a fixed set of `UPPER_SNAKE` variables (e.g. `TIMEOUT`, `ENVIRONMENT`,
`BASIC_AUTH_USERNAME`/`BASIC_AUTH_PASSWORD`, retry/proxy vars, and one per credential field). The exact
names are in `Configuration.fromEnvironment` in `src/configuration.ts` — grep it. It runs the config
through schema validation and **throws** on invalid input. (In Node, load a `.env` with `dotenv` first.)

> A `Client.fromJsonConfig(jsonString)` factory is also generated and advertised in `doc/client.md`, but
> do not build on it: it throws for every input, valid or not. Parse the JSON yourself and pass the
> object to `new Client({...})`.

## Accessing controllers — you instantiate them

Unlike some SDKs, the `Client` exposes **no controller accessor methods**. You construct each controller
yourself, passing the client, then call operations on it (see **typescript-calling-endpoints**):

```ts
import { {Controller} } from '@paypal/paypal-server-sdk';

const controller = new {Controller}(client);
const response = await controller.{operation}(/* params */);
```

OAuth grant types are the exception: an OAuth-using SDK exposes a manager property on the client, used to
fetch/refresh tokens — see **typescript-authentication**. Its name is generated and does **not** reliably
transliterate the scheme name in the spec: a scheme named `OAuthACG` yields `client.oAuthACGManager`, but
a scheme whose spec name is just a generic OAuth2 label yields `client.clientCredentialsAuthManager` —
named for the grant, not the scheme. The capital-A spelling (`oAuth…`/`OAuth…`) is reliable for the
credential *fields* (`oAuthClientId`, `oAuthToken`, `oAuthClockSkew`, …) and for a manager whose scheme is
itself OAuth-named — but **not** for scheme keys: a scheme the spec literally names `oauth2` keeps that
lowercase spelling as its key in `src/authProvider.ts` and in `req.authenticate([{ oauth2: true }])`. Grep
`public .*Manager` in `src/client.ts` for the real manager name rather than deriving it.

When the SDK declares **more than one** auth scheme the property is declared optional
(`public {scheme}Manager?: ...`) and is constructed only if you passed that scheme's credentials, so
under `strict` it is possibly `undefined` — call it as `client.{scheme}Manager?.fetchToken()`, or assert
after constructing the client with those credentials. With a single auth scheme it is non-optional and
always constructed. Grep `src/client.ts` for `public .*Manager` to get the real name and whether it
carries a `?`.

## Client lifetime and reuse

`Client` stores a `Readonly<Configuration>` and builds its request-builder factory **once** in the
constructor — treat the client as **immutable and long-lived**. Construct it once at startup and reuse it
for the process lifetime; do **not** build a new client per request (that discards connection pooling and
any cached OAuth token). Controllers are cheap, stateless wrappers over the client — instantiate freely.

```ts
// startup — construct once:
export const apiClient = new Client({ environment: Environment.{Name} /* + auth */ });

// elsewhere — reuse, wrap in a controller per call site as needed:
const controller = new {Controller}(apiClient);
```

To produce a variant with a few options changed (e.g. attach a fetched OAuth token), call
`client.withConfiguration({ ... })` — it returns a **new** `Client` merged over the current config rather
than mutating the original.

## Next

- Configure authentication → **typescript-authentication**
- Make your first call → **typescript-calling-endpoints**
- Tune retries/timeouts/proxy → **typescript-configuration-resilience**
