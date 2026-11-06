---
name: 'typescript-configuration-resilience'
description: 'Tune the PayPal Server SDK TypeScript SDK client — retries, timeouts, cancellation, proxy, logging and the base URL. Load before changing any transport setting. The option list won''t tell you two generated fields gate retrying, that `abortSignal` never reaches a token exchange, or how to reach a host no `Environment` member covers.'
---

# Configuration & resilience for an APIMatic TypeScript SDK

All configuration is passed at construction time in the single `Configuration` object (see
**typescript-client-initialization**). Transport tuning is **nested under `httpClientOptions`** — it is
not top level.

```typescript
import { Client, Environment } from '@paypal/paypal-server-sdk';

const client = new Client({
  environment: Environment.{Name},
  timeout: 30_000,                 // ms, per attempt
  httpClientOptions: {
    timeout: 30_000,               // overrides the top-level timeout when present
    retryConfig: { /* see below */ },
    proxySettings: { /* ... */ },
    httpAgent: undefined,          // custom Node http agent (keep-alive, TLS)
    httpsAgent: undefined,
  },
});
```

## Base URL / environment

There is **no free-form `baseUrl` option**. The base URL is derived from the selected `Environment`
member (plus any server parameters such as `port`) by a private resolver in `src/client.ts`.

Read the `Environment` enum in **`src/configuration.ts`** for the real member names before naming one —
they vary per API, and a name like `Production` may not exist at all.

> **To reach a host no `Environment` member covers** — a gateway, a sandbox proxy, a recorded mock, a
> base URL from an environment variable — route below the SDK first, with a proxy or a DNS entry, which
> leaves nothing for you to maintain when the runtime moves.
>
> Where neither can get you there, rewrite `request.url` in an interceptor: `getRequestBuilderFactory()`
> is public on the client and `interceptRequest` is public on the builder it returns, so the rewrite runs
> *above* the transport and retry, timeout and error mapping all still apply. Both are runtime API,
> versioned independently of this SDK, so read them before relying on them.
>
> **It does not redirect the token request, and that is the dangerous half.** The client's constructor
> builds the auth manager with `this`, and the manager immediately builds its OAuth controller from that
> same client — both before any wrapper of yours exists. The OAuth controller therefore holds the
> **unwrapped** client, so a client you redirect this way talks to your stand-in while authenticating
> against the real provider, with real credentials. Reassign the public auth-manager property after
> construction so it is rebuilt over the wrapped client, and assert in a test that the token request
> reached your stand-in.
>
> Do not reach for the transport adapter in **typescript-testing** for this: supplying your own adapter
> means owning the HTTP call the SDK was going to make, and the behaviour documented here stops
> applying.

## Retries

Retry policy lives at `httpClientOptions.retryConfig`:

```typescript
const client = new Client({
  httpClientOptions: {
    retryConfig: {
      maxNumberOfRetries: 5,
      retryInterval: 1,            // seconds
      backoffFactor: 2,
      maximumRetryWaitTime: 60,    // seconds; total retry-wait budget — 0 disables retrying entirely
      retryOnTimeout: true,
      httpStatusCodesToRetry: [408, 429, 500, 502, 503, 504],
      httpMethodsToRetry: ['GET', 'PUT'],
    },
  },
});
```

The seven fields above are the complete set. **Their defaults are fixed when the SDK is generated, not
by the runtime** — `maxNumberOfRetries`, `httpStatusCodesToRetry` and `httpMethodsToRetry` in particular
differ from SDK to SDK.

> Do not assume a default. Read `DEFAULT_RETRY_CONFIG` in **`src/defaultConfiguration.ts`** — that is
> the generated, authoritative value for this SDK. Retries may well be off (`maxNumberOfRetries: 0`).

> ### ⚠ Read `DEFAULT_CONFIGURATION.timeout` too — `0` means *no* timeout
>
> The timeout default is generated alongside the retry config and is commonly **`0`**, which is not
> "use a sensible default": it reaches axios as `0`, and axios treats `0` as no limit. A client built
> without setting `timeout` then waits indefinitely on a provider that accepts the connection and stops
> responding.
>
> The adapter looks like it protects you and does not. `@apimatic/axios-client-adapter` declares
> `DEFAULT_TIMEOUT = 30_000`, but applies it only when the value is `undefined` — a generated `0` is a
> real value and passes straight through. Read `DEFAULT_CONFIGURATION` in
> `src/defaultConfiguration.ts`, not the adapter's constant, and set `timeout` explicitly.

Anything you pass is merged over that default, so you can override one field and leave the rest.

> **Raising `maxNumberOfRetries` alone is not enough.** `maximumRetryWaitTime` is the total retry-wait
> budget, and a retry only happens when the computed backoff fits inside it — so when the generated
> `DEFAULT_RETRY_CONFIG.maximumRetryWaitTime` is `0` (a common generated default) **nothing is ever
> retried**, whatever `maxNumberOfRetries` says. Set both.

Notes:
- Only the methods listed in `httpMethodsToRetry` are retried. If `POST`/`PATCH`/`DELETE` are absent —
  the common case — those errors surface without any retry. Add one only if the operation is idempotent.
- `timeout` is **per attempt**, not total. To bound a whole call including retries, use an `AbortSignal`
  — but read the note below on what the signal does not reach before you treat it as a ceiling.
- Raise both only where nothing above the SDK already retries — a queue consumer, a job runner, a
  failover wrapper, or your own orchestration loop. Retry layers multiply rather than add:
  `maxNumberOfRetries: 3` is **four** requests per attempt, so inside a 3-attempt job it is twelve
  requests against an API whose rate limit counts every one.

## Per-request timeout / cancellation

Pass an `AbortSignal` as the `abortSignal` member of `requestOptions` to bound an individual call.
`requestOptions` is normally the operation's **last** parameter — an operation that also accepts
arbitrary extra form fields takes those in between, so read the signature rather than counting from the
end — but how you reach it depends on the parameter form
the operation was generated in — positional, or one collapsed options object when the operation has more
than one parameter and this build collapses them (see **typescript-calling-endpoints**). Read
the signature in `src/controllers/` first:

```typescript
const controller = new AbortController();
setTimeout(() => controller.abort(), 10_000);

// Positional: {operation}({id}: string, {optionalParam}?: string, requestOptions?: RequestOptions)
// pad the optionals you skip:
const a = await api.{operation}({id}, undefined, { abortSignal: controller.signal });

// Collapsed: {operation}({ {id}, {optionalParam} }: {...}, requestOptions?: RequestOptions)
// nothing to pad — requestOptions follows the options object, unless the signature shows a
// fieldParameters argument between them:
const b = await api.{operation}({ {id} }, { abortSignal: controller.signal });
```

The key is `abortSignal`, not `signal`, and it is the only member `RequestOptions` has.

> ### ⚠ Neither the signal nor the timeout reaches a token exchange
>
> **This applies to an SDK secured by an OAuth grant** — check `src/configuration.ts` for an
> `oAuth`-prefixed credentials property; if there is none, skip this note.
>
> An operation whose cached token is missing or expired fetches one **first**, as a separate HTTP
> request. Your `abortSignal` does not reach it: the auth manager calls the token method without the
> `requestOptions` argument that would carry it, and `fetchToken` takes only `additionalParams`, so
> there is nothing to pass from outside.
>
> `timeout` does not cover it either — it is applied per request, and the token exchange is a
> *different* request from the operation, so **a call that has to fetch a token can take up to two full
> `timeout` periods**. For a real ceiling, race the operation against your own deadline, and still
> `abort()` the controller so the operation's own request is released.

## Pagination

**No operation in this API is paginated.** `package.json` does not depend on `@apimatic/pagination`, no
method returns a `PagedAsyncIterable`, and there is no `doc/paged-async-iterable.md` — every operation is
`async`, is awaited, and hands back `ApiResponse<T>`. A list endpoint here is a plain list call: drive its
own `page`/`perPage` (or cursor) parameters yourself and stop when a page returns fewer items than you
asked for.

## Logging

**Logging is built in here**: the `Configuration` interface in
`src/configuration.ts` carries a `logging` property, and `LogLevel`, `LoggerInterface` and `ConsoleLogger`
are exported from the package root. Configure it directly — there is no need to wrap the transport:

```typescript
import { Client, LogLevel } from '@paypal/paypal-server-sdk';

const client = new Client({
  logging: {
    logLevel: LogLevel.Info,
    logRequest:  { logBody: true, logHeaders: true, headersToExclude: ['authorization'] },
    logResponse: { logBody: true, logHeaders: false },
  },
});
```

With **no** `logging` config the client uses `DEFAULT_LOGGING_OPTIONS` from
`src/defaultConfiguration.ts`, which ships a `NullLogger` — logging is silent. Supplying **any**
`logging` object switches the fallback to the runtime defaults (`ConsoleLogger` at `LogLevel.Info`), so
logging starts immediately even if you set neither `logger` nor `logLevel`; pass your own `logger` to
redirect it.

`logRequest` and `logResponse` each also accept `headersToInclude` and `headersToWhitelist`;
`includeQueryInPath` is request-only. Header masking is `maskSensitiveHeaders`, set on `logging` itself
rather than on `logResponse`.

## Next

- Step 7, stubbing the SDK → **typescript-testing**
