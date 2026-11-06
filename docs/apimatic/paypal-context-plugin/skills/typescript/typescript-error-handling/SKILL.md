---
name: 'typescript-error-handling'
description: 'Handle errors from the PayPal Server SDK TypeScript SDK. Load before your first try/catch around a call, or when building an error-translation layer. The thrown type won''t tell you `result` is undefined on a bare `ApiError`, that an error payload keeps the wire''s own field names, or that the `doc/` Errors table can name classes nothing registers.'
---

# Error handling for an APIMatic TypeScript SDK

Endpoint methods **throw on non-success responses** — there is no non-throwing variant, and this is not a
build option: the shared `@apimatic/core` request builder installs a response validator that throws for
any status outside `200`–`299`, on every operation of every build.

The thrown type is always `ApiError`, but it comes in **two shapes**, depending on the status code the
operation — or the client-wide `withErrorHandlers` block in `src/client.ts`, which registers the spec's
global errors for every operation at once — maps:

- **Typed subclass (Case A)** — a `{ErrorModel}Error` subclass of `ApiError` generated under
  `src/errors/`. It is named after the **error response model**, never after the operation, and a single
  operation commonly maps several status codes to several *different* classes.
- **Base `ApiError` (Case B)** — for a status the operation maps to no typed model, `err` is `ApiError`
  itself.

## Which error class does an endpoint throw?

Do **not** guess from the operation name. For the operation you are calling, either:

- open its `## Errors` table in `doc/controllers/{group}.md`, which lists the exception class per status
  code; or
- read the `req.throwOn(<status>, <ErrorClass>, ...)` and `req.defaultToError(<ErrorClass>, ...)` lines
  in the operation's own method body in `src/controllers/`.

Because one operation can raise several classes, a catch ladder needs **one `instanceof` branch per
class** you want to treat specially, with a final `instanceof ApiError` branch as the catch-all — or just
the single `ApiError` branch if you handle them uniformly.

## Catch the exception

`ApiError<T>` exposes `statusCode: number`, `headers: Record<string, string>`, `request: HttpRequest`,
`result: T | undefined` (the **parsed** JSON payload) and `body: string | Blob | NodeJS.ReadableStream`
(the **raw, unparsed** payload).

`result` is populated only for the typed `ApiError` *subclasses*. A bare `ApiError` — the
`rb.defaultToError(ApiError)` path taken for any status the operation maps to no typed model — never
gets that parse, so its `result` is always `undefined` and only `body` is filled in. Read `body` on
Case B.

Typed subclasses add **no members of their own** — they are one-liners
(`export class {ErrorModel}Error extends ApiError<{Payload}> {}`), so the payload fields are on the
inherited `err.result`, not on `err` directly.

> **An error payload's members keep the spec's own field names — they are not camelCased like a
> model's.** An ordinary model pairs an interface of camelCase members with a schema mapping each to
> its wire name; the payload interface beside an error class carries the raw field names and has **no
> schema** beside it, and the runtime `JSON.parse`s the body straight onto `result`. So a payload
> documenting an underscored or dotted field is read at that
> exact spelling — `err.result?.some_field`, never `err.result?.someField` — and carrying the casing
> used everywhere else in the SDK across to an error is the way to get it wrong. Open the payload
> interface in `src/errors/` and copy the member names from there.

### Case A — the status maps to a typed `{ErrorModel}Error`

```typescript
import { Client, ApiError, {ErrorModel}Error } from '@paypal/paypal-server-sdk';

try {
  const response = await api.{operation}(/* ... */);
  // use response
} catch (err) {
  if (err instanceof {ErrorModel}Error) {
    // the typed payload is on err.result (possibly undefined) — open the error class
    // under src/errors/ for its payload interface
    console.error('Typed error:', err.statusCode, err.result?.code, err.result?.message);
  } else if (err instanceof ApiError) {
    // Fallback for any other API error
    console.error(`HTTP ${err.statusCode}:`, err.result ?? err.body);
  } else {
    throw err;  // re-throw non-API errors (network, timeout, etc.)
  }
}
```

> ### ⚠ An error class whose name collides with a model is not the thing you import
>
> The root barrel re-exports the error classes with `export *` and lists the models with explicit
> `export { Name } from …`. An explicit named export **shadows** a `export *` of the same name, so where
> a generated error class and a generated model share a name, **the model wins and the class is
> unreachable from the package root**. The package's `exports` map usually declares only `"."`, so there
> is no deep-import path to reach past it either.
>
> The symptom is not a missing import — it is an `instanceof` that cannot work, on a name the SDK really
> does export:
>
> ```
> error TS2359: The right-hand side of an 'instanceof' expression must be ... a class ...
> ```
>
> and in plain JS, `TypeError: Right-hand side of 'instanceof' is not callable` — thrown **inside your
> catch block**, so it replaces the error you were handling and loses its payload. The class is still
> what gets thrown, with its typed `result` populated; it simply cannot be named.
>
> **One line settles it before you write the branch**, because a class is callable and a generated enum
> is not:
>
> ```typescript
> import * as sdk from '@paypal/paypal-server-sdk';
> typeof sdk.{ErrorModel}Error === 'function';   // false ⇒ shadowed by a same-named model
> ```
>
> Where it is shadowed, branch on `err.statusCode` and the shape of `err.result` rather than on the
> class, and keep the `instanceof ApiError` catch-all — which is unaffected, because nothing collides
> with it. A `constructor.name` comparison is not a substitute: it does not survive minification.

`ApiError` and every generated error class are exported from the **package root** — there is no
`@paypal/paypal-server-sdk/errors` subpath (`.` and `./metadata` are the only exported subpaths).

### Case B — the status maps to no typed model

`err` is `ApiError` — read the status off it, and the payload off **`body`**: nothing parsed the body
into `result` on this path, so `err.result` is `undefined` here.

```typescript
import { ApiError } from '@paypal/paypal-server-sdk';

try {
  const response = await api.{operation}(/* ... */);
  // use response
} catch (err) {
  if (err instanceof ApiError) {
    console.error(`HTTP ${err.statusCode}`);
    console.error(err.body);        // err.result is undefined on a bare ApiError
  } else {
    throw err;
  }
}
```

`body` is `string | Blob | NodeJS.ReadableStream`, so parse it yourself (`JSON.parse(err.body as string)`
in Node) if you need the fields.

Response headers — rate-limit headers included — are on `err.headers` on both shapes; no special call is
needed to reach them.

## Notes

- Network/transport failures (connection refused, DNS failure, TLS error) surface as errors from the underlying axios transport, **not** as `ApiError`; cancellation via an `AbortSignal` surfaces as `AbortError`. Handle both separately from `ApiError` — the `else { throw err; }` branches above exist for exactly this.
- When none of an operation's accepted auth combinations has its credentials configured, the composite
  auth provider throws a **plain `Error`** (message: `Required authentication credentials for this API
  call are not provided or all provided auth combinations are disabled`) before the request is sent. It
  is not an `ApiError`, so it falls through to the `else { throw err; }` branch. There is no `AuthError`
  type. Where the SDK generates a fallback credentials object (a scheme with a deprecated bare-string
  field — check whether `src/client.ts` hands `createAuthProviderFromConfig` a cloned config), that
  pre-flight throw never fires: the call goes out with an empty credential and returns a `401` as an
  `ApiError` instead. See **typescript-authentication**.
- Any retrying has already happened by the time the error reaches you — see
  **typescript-configuration-resilience** for what this SDK retries.

## Next

- Step 6, retries, timeouts, cancellation, proxy, logging and the base URL → **typescript-configuration-resilience**
- Step 7, stubbing the SDK → **typescript-testing**

Retry and timeout behaviour is named above only where an error surfaces it. The **defaults** — what this client does when you configure nothing — belong to **typescript-configuration-resilience**, and reading them here is not a substitute for reading them there.
