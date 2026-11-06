---
name: 'typescript-getting-started'
description: 'Entry point for integrating the PayPal Server SDK TypeScript/Node SDK (APIMatic-generated, built on the @apimatic/* runtime packages). Carries the SDK''s identity — npm package, `Client` class, `Configuration`, environments, the `ApiError` base — the package layout, and where to read the source. Load this first, before any other typescript-* skill.'
---

# Getting started with an APIMatic-generated TypeScript SDK

This is the **SDK-specific** reference and grounding layer, and the entry into the companion
`typescript-*` skills. The SDK is built on the shared `@apimatic/*` runtime packages — always `@apimatic/core`, `@apimatic/schema`,
`@apimatic/axios-client-adapter`, `@apimatic/authentication-adapters` and `tslib`, plus feature-gated
ones such as `@apimatic/oauth-adapters` and `@apimatic/pagination`. **`package.json` `dependencies` is
the authoritative list — read it rather than assuming.** For the general patterns that apply to *any* such SDK (client setup, auth, calling endpoints, models, error
handling, retries, testing), see the companion API-agnostic skills: `typescript-client-initialization`,
`typescript-authentication`, `typescript-calling-endpoints`, `typescript-models`,
`typescript-error-handling`, `typescript-configuration-resilience`, `typescript-testing`.

> **Before writing any integration code, locate the SDK source on disk** (see the *SDK source* section
> below) and read it to confirm every signature, interface, enum, schema, and error type as you go. The
> source is obtained exactly as that section describes. Do **not** vendor or edit it inside your project;
> regenerate the SDK instead if something needs to change.

## SDK identity

| | |
| --- | --- |
| API | `PayPal Server SDK` |
| Runtime dependencies | always `@apimatic/core`, `@apimatic/schema`, `@apimatic/axios-client-adapter`, `@apimatic/authentication-adapters` and `tslib`; plus feature-gated ones — `@apimatic/oauth-adapters` (OAuth), `@apimatic/pagination` (paginated endpoints), `@apimatic/sse` (`text/event-stream` endpoints), `@apimatic/xml-adapter` (XML APIs). **`package.json` `dependencies` is authoritative — read it rather than assuming this list is complete.** |
| npm package id | `@paypal/paypal-server-sdk` (version `2.5.0`) — the `"name"` in `package.json` |
| Install | `npm install @paypal/paypal-server-sdk` |
| Client | a single exported `Client` class, constructed with `new Client(config?: Partial<Configuration>)` |
| Configuration | a plain `Configuration` **options object** (interface in `src/configuration.ts`), passed to the constructor; all fields optional via `Partial` |
| Auth | **this API declares at least one scheme**, so the `Configuration` carries one nested credential **object** per scheme, named `...Credentials` — **read the property name off `src/configuration.ts`; do not derive it from the scheme name in the spec.** The generator often names it after the auth *type* instead (a scheme named `APIKeyHeader` becomes `customHeaderAuthenticationCredentials`), and only sometimes after the scheme (`basicAuth` → `basicAuthCredentials`). Set it as an object literal; a deprecated top-level bare-string field may also exist alongside it. See **typescript-authentication** |
| Environment | an `enum Environment` in `src/configuration.ts` — read it for the real member names |
| Controllers | one class per resource group, named for the group plus this SDK's controller postfix — read the whole name off the `export class` lines in `src/controllers/`; you instantiate it yourself, `new {Controller}(client)` — **not** accessors on the client |
| Return type | every operation returns `Promise<ApiResponse<T>>` |
| Base error | `ApiError<T>` (from `@apimatic/core`, re-exported by the SDK) — thrown on non-2xx; see **typescript-error-handling** |

Both were recorded with this SDK, so they are the coordinates a consumer installs rather than whatever this build happened to produce. Pin them as they stand.

## Package layout

APIMatic TypeScript SDKs live under `src/`, with everything re-exported from `src/index.ts`:

- `src/client.ts` — the `Client` class (`constructor(config?: Partial<Configuration>)`, `withConfiguration`,
  static `fromJsonConfig` / `fromEnvironment`, and the `getBaseUri` base-URL resolver). OAuth-using SDKs
  expose a public manager property here, whose generated name need not match the scheme name in the spec —
  grep `public .*Manager` for the real name.
- `src/configuration.ts` — the `Configuration` interface (timeout, environment, credential objects,
  `httpClientOptions`), the `Environment` enum, and the env/JSON config readers.
- `src/defaultConfiguration.ts` — `DEFAULT_CONFIGURATION` and `DEFAULT_RETRY_CONFIG` (the actual defaults).
- `src/controllers/` — one controller class per API resource group, all extending the generated base
  controller. Its name is `Base` + the SDK's controller postfix (e.g. `BaseApi` in
  `src/controllers/baseApi.ts` when the postfix is `Api`); the postfix is fixed at generation time, so
  read the real class names off the `export class` lines in `src/controllers/` rather than assuming
  either postfix.
- `src/models/` — request/response **interfaces**, each paired with a `{name}Schema` for runtime
  (de)serialization; `src/models/containers/` for oneOf/anyOf union types. **This is where field names,
  optionality, and enum values live.**
- `src/errors/` — typed error subclasses, one per error response model
  (`class {Name}Error extends ApiError<{Payload}>`), each re-exported from `src/index.ts`.
- `src/core.ts` and `src/clientAdapter.ts` — thin re-exports of the runtime (`@apimatic/core`,
  `@apimatic/axios-client-adapter`); this is where `ApiError`, `ApiResponse`, `RetryConfiguration`,
  `HttpClientOptions`, `RequestOptions` actually come from.
- `src/schema.ts` — re-export of `@apimatic/schema` (the `object`/`optional`/`oneOf`/… combinators).

## Install

This SDK is published out of `https://github.com/paypal/PayPal-TypeScript-Server-SDK`, branch `main` — take that branch explicitly rather than the repository default, which is not necessarily where this SDK is released from. Which registry that pipeline pushes to is a property of the pipeline rather than of the SDK. Try the install command below as-is first: if it resolves, the package is on the public registry and there is nothing further to configure. Only if it 404s do you need the feed — take it from the repository's publish workflow, or from whoever owns the pipeline, and configure that registry before retrying.

```bash
npm install @paypal/paypal-server-sdk
```

It lands in `package.json` as an ordinary dependency. Pin the exact version:
regenerating the SDK publishes a new one, and a caret range would move the surface under you without
saying so.

```json
"dependencies": {
  "@paypal/paypal-server-sdk": "2.5.0"
}
```

Confirm what actually resolved — npm keeps serving the copy already in `node_modules/` until you ask
for the new version by name:

```bash
npm ls @paypal/paypal-server-sdk
```

```ts
import { Client, Environment, ApiError } from '@paypal/paypal-server-sdk';
// controllers and model types are also exported from the package root:
import { {Controller} } from '@paypal/paypal-server-sdk';
```

Everything public is re-exported from `src/index.ts`, so import names come from the **package root** — you
don't import from subpaths. `npm install` pulls the `@apimatic/*` runtime packages transitively.

> **The root barrel exports some names as values and others as types, and the split is not obvious from
> the name.** `src/index.ts` emits `export { X }` for a model that is an **enum** or that **has child
> types** (a union base other models extend), and `export type { X }` for every other model. So a plain
> model interface exists only at compile time, while an enum or a union base is a real runtime binding.
>
> That matters because a single `import { A, B } from '@paypal/paypal-server-sdk'` mixing the two **fails under
> `isolatedModules` or `verbatimModuleSyntax`** — increasingly the default — and the error names the
> type-only import rather than explaining the rule. Split it:
>
> ```ts
> import { {EnumOrUnionBase} } from '@paypal/paypal-server-sdk';        // value: usable at runtime
> import type { {Model} } from '@paypal/paypal-server-sdk';             // type only
> ```
>
> **Read `src/index.ts` to see which kind a name is** — grep it for the name and look at whether its
> line says `export` or `export type`. Do not infer it from whether the thing "sounds like" a type.

## SDK source — read it in place

You will constantly need to confirm real constructor/method signatures, model interfaces, schemas, enum
values, and error types, and the **only reliable way** is to read the SDK source.

Clone it and read the clone — it is the source this pack documents:

```bash
git clone --filter=blob:none --branch main https://github.com/paypal/PayPal-TypeScript-Server-SDK
```

**The clone is a branch; your install is pinned.** Check out the tag matching `2.5.0`, the version installed above before you read anything from it — a branch keeps moving after a release is cut, so the default checkout can be a different SDK than the one you compile against, and nothing in the tree will tell you. `git ls-remote --tags` lists what the repository offers; if no tag matches, treat every signature you read as unconfirmed rather than assuming it carried over. Clone it outside your project directory and treat it as read-only. It is a reference, not a dependency: what you build against is the package installed above, never this checkout.

An existing copy, if you already have one, is in whichever of these applies:

- the **unpacked SDK directory** you were given (the one containing `package.json` and `src/`); or
- **`node_modules/@paypal/paypal-server-sdk/`** in your project, once installed.

Treat it as a read-only reference and grep it locally.

Layout — grep here first:

- `package.json` — the npm `name`, `version`, `engines.node`, and the `@apimatic/*` `dependencies`.
- `src/configuration.ts` — the `Configuration` fields, the `Environment` enum, and the env-var names in
  `fromEnvironment`.
- `src/client.ts` — the `Client` constructor and (for OAuth) the manager properties.
- `src/controllers/*.ts` — operation methods and their `Promise<ApiResponse<T>>` signatures.
- `src/models/` — request/response interfaces, enums, and `containers/` unions; **this is where field
  names live**.
- `src/errors/` — the typed error subclasses this build emits, one per error response model.
- `README.md` and `doc/` — a generated, human-readable index: `doc/client.md`, `doc/auth/*.md`,
  `doc/controllers/*.md`, `doc/models/*.md`, `doc/http-client-options.md`, `doc/retry-configuration.md`,
  `doc/api-response.md`, `doc/api-error.md`, `doc/environment-based-client-initialization.md`,
  `doc/configuration-based-client-initialization.md`. In the repository it is the fastest way to find
  an operation, its parameters and a copy-pasteable snippet, then open the `.ts` file for the exact
  signature. **It is not in the installed package** — everything else listed above ships in
  `node_modules/@paypal/paypal-server-sdk/`; `doc/` does not, because npm publishes only what the `files`
  field names. With only the package, `src/controllers/*.ts` is the equivalent starting point.

## Placeholder legend

Samples across these skills write `{...}` for a name that differs per API. **They are never literal** —
resolve each one from this SDK's source before you write code. Anything already concrete for this SDK
(package id, API name, install command) is spelled out for you; if it is still in braces, it is yours to
look up.

| Placeholder | Stands for | Resolve it from |
| --- | --- | --- |
| `{Controller}` | a controller class — the whole name, postfix included, as in `new {Controller}(client)` | the `export class` lines in `src/controllers/`. The postfix (`Api`, `Controller`, …) is this SDK's controller-naming setting, fixed at generation time — read the real names rather than assuming either |
| `{group}`, `{apiGroup}` | the resource group a controller covers | the file names under `doc/controllers/` |
| `{operation}` | an operation method on a controller | the controller class body, or the operation list in `doc/controllers/{group}.md` |
| `{RequestType}`, `{Payload}` | a request or response model interface | `src/models/` — one file per model, each paired with a `{name}Schema` |
| `{Name}`, `{field}` | a model interface and one of its properties | the interface declaration in `src/models/` |
| `{optionalParam}`, `{requiredParam}`, `{pathOrQueryParam}` | one parameter of the operation you are calling | the operation's signature in `src/controllers/` |
| `{EnumType}`, `{enumType}`, `{enumProp}` | a generated enum and a property typed by it | the enum declarations in `src/models/` |
| `{Union}`, `{Variant}`, `{V}` | a oneOf/anyOf union and one of its variants | `src/models/containers/` |
| `{ItemType}`, `{Collection}` | the element type of an array property | the property's declared type in `src/models/` |
| `{ErrorModel}`, `{ErrorResponse}` | a generated error class | `src/errors/`. Named after the error **response model**, never after the operation — see **typescript-error-handling** |
| `{scheme}` | an auth scheme, as it names the client's manager property | grep `public .*Manager` in `src/client.ts` |
| `{basicAuthProperty}`, `{bearerAuthProperty}`, `{apiKeyProperty}`, `{oAuthProperty}` | the credentials property for one scheme on `Configuration` | the credential fields in `src/configuration.ts` |
| `{keyName}` | the literal header or query parameter an API key is sent as | the API-key credentials type in `src/configuration.ts` |
| `{ScopeEnum}` | the generated OAuth scope enum — emitted only for a grant whose spec declares scopes, so an SDK can have none | the `### Scopes` table in that grant's `doc/auth/*.md` (usually the authorization-code one); if the grant's credentials object in `src/configuration.ts` has no `oAuthScopes`, there is no enum |
| `{id}`, `{placeholder}` | a stand-in value in an example | nothing to look up — substitute your own |

Any other `{...}` you meet is a local example; the sentence around it says what belongs there.

## Integration workflow — load the companion skill at each step

**Load the skill named for a step before you write that step's code, even where you have already read
the source.** The generated source is authoritative for the SDK's *surface*; these skills carry the
usage rules a signature cannot show, and each one names the trap that surface hides.

1. **typescript-client-initialization** — before you construct the client.
2. **typescript-authentication** — before you set credentials, and when a call returns 401 or 403.
3. **typescript-calling-endpoints** — before the first operation call.
4. **typescript-models** — as soon as a request or response field is not a plain string or number.
5. **typescript-error-handling** — before your first `try`/`catch` around a call.
6. **typescript-configuration-resilience** — before you ship. Its subject is the client's *defaults*, which apply whether or not you set anything, so this step is not conditional on changing one.
7. **typescript-testing** — before you stub the SDK.

## Next

- Step 1, construct the client → **typescript-client-initialization**

Every skill below ends with the step after it, so the footers walk the workflow above in order rather than offering a menu beside it.
