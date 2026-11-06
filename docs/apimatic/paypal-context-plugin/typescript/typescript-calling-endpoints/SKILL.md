---
name: 'typescript-calling-endpoints'
description: 'Call operations on the PayPal Server SDK TypeScript SDK. Load before the first call, and when building a request body or reading a response. The signature won''t tell you controllers are constructed rather than accessed off the client, that an operation takes either positional parameters or one options object, or where `requestOptions` sits.'
---

# Calling endpoints on an APIMatic TypeScript SDK

> **`doc/` is in the SDK's repository, not in the installed package.** Every pointer to
> `doc/controllers/` or `doc/client.md` below assumes you have the repository checked out. Where you
> only have the installed artifact — the common case — the equivalent source is the operation's own signature in `src/controllers/`, and it is
> authoritative in a way the docs are not.

Operations are **async methods on a controller class that you instantiate yourself** — they are *not*
properties on the client:

```typescript
import { Client, {Controller} } from '@paypal/paypal-server-sdk';

const client = new Client({ /* ... */ });
const api = new {Controller}(client);          // you construct this
const response = await api.{operation}(/* ... */);
```

There is no `client.{apiGroup}.{operation}(...)` accessor and no operation sitting directly on the
client. Controllers live in `src/controllers/`, one file per API group, each extending a shared base
class. **Read the exported class name from that file** — the suffix varies per SDK (`Api`, `Controller`, …). Operation names
follow no fixed verb/resource pattern — take the real name from the source.

## Method signature convention

Every endpoint method is `async` (they all return a `Promise`), and there are **two parameter forms**.
Which one an operation uses is decided at generation time, so **read the method signature in
`src/controllers/` before writing the call** — both forms end with `requestOptions`.

```typescript
// Form A — positional, in declaration order
async {operation}(
  {requiredParam}: {RequestType},
  {optionalParam}?: string,
  requestOptions?: RequestOptions
): Promise<ApiResponse<{ReturnType}>>

// Form B — one destructured options object, when parameters are collapsed
async {operation}(
  { {requiredParam}, {optionalParam} }: { {requiredParam}: {RequestType}; {optionalParam}?: string },
  requestOptions?: RequestOptions
): Promise<ApiResponse<{ReturnType}>>
```

- **The rule:** an operation is generated in Form B when it has **more than one** non-constant parameter
  **and** this build collapses them, or that endpoint collapses its own.
  Everything else is Form A. Do not infer the form from one operation — check the one you are calling.
- **That count is of declared parameters, not of required ones.** The optional ones count too, so an
  operation taking one required path parameter plus a few optional headers or filters is a
  *multi*-parameter operation and collapses on such a build — `{operation}({ {requiredParam} })`, not
  `{operation}({requiredParam})`. Only an operation with exactly one parameter and no optional ones
  stays positional. Reading "it really only needs an id, so it must be positional" is how this goes
  wrong; the signature settles it in one line.
- **In Form A**, to reach a later optional parameter, pass `undefined` for the ones you skip (see the
  next section). **In Form B** you simply omit the key, and the skipping problem does not arise.
- **Read the parameter list at the top of the method in `src/controllers/`** — order, names and
  optionality come from the operation itself, not from any fixed convention. `doc/controllers/{group}.md`
  lists the same parameters plus a runnable call.
- **`requestOptions`**: the **last** parameter. It currently carries only `abortSignal` for per-call
  cancellation — there is no per-request timeout or header override on it; timeouts, retries and headers
  are configured on the client (see `typescript-configuration-resilience`).
- **Return type** varies by operation — see [Reading the response](#making-the-call-and-reading-the-response).
- Operations **throw `ApiError`** on non-2xx — see `typescript-error-handling`.

## List/search endpoints — mind the positional order

List/search operations often declare many optional parameters. **In Form A** they are positional, so you
must count them: pass `undefined` for every parameter you skip ahead of the one you want. (In Form B this
section does not apply — name the keys you want and omit the rest.)

```typescript
const response = await api.{operation}(
  {EnumType}.SomeConstant,   // status
  undefined,                 // serviceLevel — skipped
  undefined,                 // createdAfter — skipped
  100                        // limit
);
```

**Open the method in `src/controllers/` and count the parameters** before writing the call — miscounting
binds your value to the wrong parameter and still compiles when the types happen to match.


## Building request models

Request bodies are plain objects conforming to a TypeScript interface. Required properties must be set; optional ones are `undefined` by default and are omitted from the JSON when not provided:

```typescript
const body: {RequestType} = {
  requiredProp: value,   // required — must be provided
  optionalProp: value,   // optional — leave out to omit from the request
};
```

A request body's **shape varies**: some are **flat** (scalar members directly on the object), others
**nest an inner resource object**. Open the request model interface under `src/models/` to see its real
required/optional members before writing the literal.

## Enums

Enums are generated as real TypeScript `enum` declarations exported from the SDK (member = wire value).
Reference the member — a bare string literal is **not** assignable to an enum-typed property:

```typescript
someProp: {EnumType}.SomeConstant;   // correct
someProp: 'server_provided_value';   // compile error — not assignable to {EnumType}
```

See **typescript-models** for the declaration shape and the unknown-value caveat.

## Union types, collections, and dates

Some properties are not plain scalars: discriminated union types, `Array<T>` collections, and date/time fields that are plain strings in a format the SDK neither converts nor checks. If a request property or response field is one of these, see **typescript-models** for how to construct and read it.

## Making the call and reading the response

Every operation returns `ApiResponse<T>` — the deserialized value is on `.result`, with
`.statusCode`, `.headers` and the raw `.body` alongside it:

```typescript
const response = await api.{operation}({pathOrQueryParam}, body);
console.log(response.statusCode);
const resource = response.result;
```

**The wrapped `T` varies per operation** — read the method's declared return type in the SDK source and
handle it accordingly:

- **A model** — `Promise<ApiResponse<{Payload}>>`: read `response.result`.
- **An array** — `Promise<ApiResponse<{ItemType}[]>>`: iterate `response.result`.
- **Nothing** — `Promise<ApiResponse<void>>`: `await` it and read `response.statusCode`.
- **Binary** — `Promise<ApiResponse<NodeJS.ReadableStream | Blob>>` for file/label downloads: stream or
  buffer `response.result`; it is not JSON.


**No operation in this API is paginated**, so no method returns a `PagedAsyncIterable` — every one is
`async` and awaited. Endpoints in the same family can still differ in the wrapped `T` — one a model, its
sibling an array — so let each method's declared return type guide how you read it.

## AbortSignal / cancellation

Pass an `AbortSignal` as the `abortSignal` member of `requestOptions` — the **last** parameter in both
forms, so how you reach it follows the form the operation was generated in (see [Method signature
convention](#method-signature-convention)):

```typescript
const controller = new AbortController();
setTimeout(() => controller.abort(), 30_000);

// Form A — async {operation}({id}: string, {optionalParam}?: string, requestOptions?: RequestOptions)
// pad the optionals you skip:
const a = await api.{operation}({id}, undefined, { abortSignal: controller.signal });

// Form B — async {operation}({ {id}, {optionalParam} }: {...}, requestOptions?: RequestOptions)
// nothing to pad — requestOptions follows the options object, unless the signature shows a
// fieldParameters argument between them:
const b = await api.{operation}({ {id} }, { abortSignal: controller.signal });
```

`abortSignal` is the **only** member of `RequestOptions`, and the key is `abortSignal`, not `signal`. An
aborted call rejects with `AbortError`, not `ApiError`.

## Worked example — a list/GET call

No operation in this API is paginated, so a list endpoint is an ordinary awaited call returning
`Promise<ApiResponse<{ItemType}[]>>`:

```typescript
const response = await api.{operation}('some_filter', undefined, 20);
for (const item of response.result) {
  console.log(item.id);
}
```

In Form B the same call names the keys instead — `api.{operation}({ filter: 'some_filter', limit: 20 })` —
with no `undefined` placeholders. To walk a long list, drive the endpoint's own paging parameters yourself
and stop when a response comes back with fewer items than you asked for; see
**typescript-configuration-resilience**.

## Finding the right method in the SDK source

Read these from the SDK **source** files, not by inspecting the compiled `.d.ts` only — the source has JSDoc comments, the full params interface, and the request-builder internals.

- Every operation lives on a **controller class** in `src/controllers/`, one file per API group. `ls` that
  directory to find the group, then read the exported class name off its `export class` line — the
  suffix varies per SDK (`Api`, `Controller`, …), so do not assume it.
- Request/response/enum types live under `src/models/`; error types under `src/errors/`.

## Next

- Union types, collections, dates, enums → **typescript-models**
- Errors and status codes → **typescript-error-handling**
- Retries, timeouts, logging → **typescript-configuration-resilience**
