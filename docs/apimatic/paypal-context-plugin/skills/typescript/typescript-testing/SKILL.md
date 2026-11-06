---
name: 'typescript-testing'
description: 'Unit-test code that calls the PayPal Server SDK TypeScript SDK. Load before stubbing the SDK. The type won''t tell you the seam is a stub adapter passed through `unstable_httpClientOptions`, that the SDK ships no mocking helpers, or that a stubbed 5xx needs the retry config zeroed to fail on the first attempt.'
---

# Testing code that uses an APIMatic TypeScript SDK

The SDK has **no mocking helpers**. Its transport is an axios client
(`@apimatic/axios-client-adapter`), and the only injection point exposed on `Configuration` is
**`unstable_httpClientOptions`** — passed straight through to that adapter as its axios config. Supplying
a stub **axios adapter** there is the in-process seam: no network, no global patching.

> `unstable_` means exactly that: it is an escape hatch, not a stable API, and may change between SDK
> versions. If you would rather not depend on it, stub at the HTTP layer with `nock` (Node) or `msw`
> instead — the assertions below apply either way.

The samples below use Jest `test` + `expect` for reference only — mirror whatever the project already
uses.

## A reusable stub helper

```typescript
import { Client } from '@paypal/paypal-server-sdk';

function clientReturning(status: number, body: unknown): {
  client: Client;
  requests: () => any[];
} {
  const requests: any[] = [];

  const client = new Client({
    // Dummy credentials for whatever scheme the operation requires. Auth is applied BEFORE the
    // transport, so an unauthenticated stub client throws instead of reaching your adapter.
    // Copy the property name and its inner field names from the `Configuration` interface in
    // src/configuration.ts; prefer an API-key/basic scheme over an OAuth one.
    {apiKeyProperty}: { /* dummy values */ },
    unstable_httpClientOptions: {
      // An axios adapter: receives the request config, returns an axios response.
      adapter: async (config: any) => {
        requests.push(config);
        return {
          // The SDK disables axios response transformation (`transformResponse: []`), so the
          // adapter must hand back the raw serialized body exactly as the wire would — a string.
          data: typeof body === 'string' ? body : JSON.stringify(body),
          status,
          statusText: '',
          headers: { 'content-type': 'application/json' },
          config,
        };
      },
    },
    httpClientOptions: {
      retryConfig: { maxNumberOfRetries: 0 },  // stubbed 5xx fails fast, no backoff wait
    },
  });

  return { client, requests: () => requests };
}
```

**Capture every intercepted call, not just the last one.** A single overwritten variable
(`captured = config`) points every assertion at whichever request fired **last**, which is not
necessarily the one the test is about: an operation whose scheme fetches a token sends that token
request through this same adapter first, and on a call that fails during auth the last — and only —
request captured is the token one. Keep a list, as above, and select by URL.

If the operation needs **no** auth, drop the credentials line. If it needs OAuth and the API also
declares a non-OAuth scheme, prefer stubbing that one — an OAuth stub adds a token-fetch call through
the same adapter, so the adapter is invoked once more than the operation itself accounts for.

**Where an OAuth grant is the only scheme the API declares, there is no other scheme to substitute, and
an unhandled token fetch fails the call before the operation is reached** — reporting a
schema-validation failure that names the *token* type and never mentions your stub. Two routes out, and
the first is usually the one you want:

**Seed a token so no fetch happens.** The manager fetches only when the cached token is missing or past
its `expiry`, so a credentials object carrying an unexpired one never reaches the network. Nothing but
the operation then arrives at your adapter, which keeps invocation counts equal to the calls your test
actually makes:

```typescript
{oAuthProperty}: {
  oAuthClientId: 'dummy-id',
  oAuthClientSecret: 'dummy-secret',
  oAuthToken: {
    accessToken: 'seeded-token',
    tokenType: 'Bearer',
    expiry: BigInt(Math.floor(Date.now() / 1000) + 3600),
  },
},
```

Read the token type's own members off `src/models/` — which are required, and whether `expiry` is the
field this build compares against — rather than copying the shape above wholesale.

**Or answer the token request from the adapter**, which is what you want when the exchange itself is
under test, or when you would rather not depend on how expiry is decided. Branch on the request URL,
taking the real token path from the generated OAuth authorization controller's `createRequest(...)` call
under `src/controllers/` rather than guessing it — it is the spec's token URL and differs between
APIs — and answer that one path with a token payload instead of the body under test:

```typescript
adapter: async (config: any) => {
  requests.push(config);
  if (config.url.includes('{tokenPath}')) {      // the real path, read from the controller
    return {
      data: JSON.stringify({ access_token: 'stub-token', token_type: 'Bearer', expires_in: 3600 }),
      status: 200, statusText: '', headers: { 'content-type': 'application/json' }, config,
    };
  }
  return {
    data: typeof body === 'string' ? body : JSON.stringify(body),
    status, statusText: '', headers: { 'content-type': 'application/json' }, config,
  };
},
```

The required members are the ones the token model declares non-optional — read them off its interface
under `src/models/`, where the schema beside it also gives their wire spellings. Omitting one fails the
token response's own deserialization, so the operation is never reached.

## Test a success path

```typescript
test('returns deserialized body', async () => {
  const { client } = clientReturning(200, { id: 123 });
  const api = new {Controller}(client);

  const response = await api.{operation}(/* args — see the signature */);

  expect(response.statusCode).toBe(200);
  expect(response.result.id).toBe(123);
});
```

Operations return `ApiResponse<T>`, so the deserialized payload is at `.result` — never a bare property
on `response`.

`/* args — see the signature */` stands for the operation's arguments in the form it was generated in:
positional parameters, or a **single options object** bundling them by name when the operation has more
than one parameter and this build collapses them. Copy the shape from the method in
`src/controllers/` — a call written in the wrong form does not compile, so the test never runs.

## Test an error path

Endpoint methods throw `ApiError` on non-2xx (see **typescript-error-handling**).

The thrown value is either a typed `{ErrorResponse}Error` subclass (**Case A**) for statuses the operation
maps to an error model, or base `ApiError` (**Case B**) otherwise.

Error classes are named after the error **response model**, not the operation, and one operation can
throw several. Read the `req.throwOn(<status>, <ErrorClass>, ...)` and `req.defaultToError(...)` lines in
the operation's method in the controllers folder — and, where the method has none, the client-wide
`withErrorHandlers` block in `src/client.ts`, which registers the spec's global errors for every
operation — to get the class for the status code you are stubbing.

**Assert the concrete class, not `ApiError`** — every typed class derives from it, so a test expecting
`ApiError` passes for all of them and proves nothing about which one was raised.

**Case A — typed `{ErrorResponse}Error`:**

```typescript
// Typed error classes are re-exported from the package root; `.` and `./metadata`
// are the only exported subpaths, so there is no `/errors` import path.
import { {ErrorResponse}Error } from '@paypal/paypal-server-sdk';

test('throws typed error on API error', async () => {
  const { client } = clientReturning(422, { errors: ['bad input'] });
  const api = new {Controller}(client);

  await expect(
    api.{operation}(/* args — see the signature */)
  ).rejects.toThrow({ErrorResponse}Error);
});
```

**Case B — base `ApiError`:**

```typescript
import { ApiError } from '@paypal/paypal-server-sdk';

test('throws ApiError on non-2xx', async () => {
  const { client } = clientReturning(422, { errors: ['bad input'] });
  const api = new {Controller}(client);

  await expect(
    api.{operation}(/* args — see the signature */)
  ).rejects.toBeInstanceOf(ApiError);

  try {
    await api.{operation}(/* args — see the signature */);
  } catch (err) {
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).statusCode).toBe(422);
  }
});
```

## Assert the outgoing request

The stub captures the **axios request config**, so you can assert method, URL, headers and body off it:

```typescript
test('sends correct request', async () => {
  const { client, requests } = clientReturning(200, {});
  const api = new {Controller}(client);

  await api.{operation}(/* args — see the signature */);

  // Select the request under test by path: a scheme that fetches a token puts its own
  // request in this list first.
  const req = requests().find((r) => r.url.includes('/expected/path'))!;
  expect(req.method.toUpperCase()).toBe('POST');
  expect(req.url).toContain('/expected/path');

  // Query parameters are already encoded into req.url — `req.params` is never populated,
  // so an assertion against it passes vacuously.
  expect(new URL(req.url).searchParams.get('limit')).toBe('25');

  // req.data is the serialized request body (a string for JSON payloads; undefined for GETs):
  expect(JSON.parse(req.data)).toMatchObject({ expectedField: 'value' });
});
```

Field names here are axios's (`method`, `url`, `data`, `headers`), not the WHATWG `Request` shape, and
`req.method` arrives lower-case — log the captured requests once if you are unsure what a given
operation produces.

## Notes

- **Disable retries in tests** (`httpClientOptions.retryConfig.maxNumberOfRetries: 0`) so a stubbed
  `5xx` fails on the first attempt instead of waiting out the backoff.
- To test that retries *do* fire, have the stub return `503` then `200` and count adapter invocations,
  with `retryConfig: { maxNumberOfRetries: 2, retryInterval: 0.01, maximumRetryWaitTime: 60 }` — both
  fields have to be non-zero, and **typescript-configuration-resilience** says why.
- Controllers are constructed from the client (`new {Controller}(client)`), so the stubbed client is the
  only transport you fake — but it must still carry credentials for the scheme the operation requires
  (see the helper above), since auth is applied before the request reaches your adapter.
- For DI-based code (e.g. NestJS), override the provider in your test module:
  ```typescript
  const { client } = clientReturning(200, {});
  const moduleRef = await Test.createTestingModule({ imports: [ApiModule] })
    .overrideProvider(Client)
    .useValue(client)
    .compile();
  ```
- To look up an operation's signature, its request type, or a `{ErrorResponse}Error`'s payload, read the
  SDK source `.ts` files — don't rely solely on the compiled `.d.ts` declarations, which may drop JSDoc
  comments and internal builder details.

## Next

That is the last step of the workflow. If you have not read **typescript-configuration-resilience** yet, read it before you ship — its subject is the client's defaults, which apply whether or not you set anything.
