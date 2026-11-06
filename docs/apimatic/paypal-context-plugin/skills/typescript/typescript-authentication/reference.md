# Authentication reference (APIMatic TypeScript)



Every auth scheme shape you can meet in one of these SDKs. The credentials properties on
the `Configuration` interface in `src/configuration.ts` are the source of truth: both the **property
names** and the **inner field names** are generated per-API, and the property name is often derived from
the auth *type* rather than the scheme name in the spec. Set every credentials property as an object
literal; where an SDK also exposes a deprecated top-level bare-string field, that field is legacy.

## Basic

```typescript
{
  {basicAuthProperty}: { username: '...', password: '...' }
}
```
Sends `Authorization: Basic base64(username:password)`.

## Bearer

```typescript
{
  {bearerAuthProperty}: { accessToken: 'ACCESS_TOKEN' }
}
```
Sends `Authorization: Bearer ACCESS_TOKEN`.

## API key — header or query

An object with **one required key per parameter the scheme declares** — each key the literal header or
query-parameter name (so it usually needs quoting). One key is common; a scheme that declares several
needs all of them. Placement is fixed by the generated scheme; its `doc/auth/` page names which
(`custom-header-signature.md` vs `custom-query-parameter.md`).

```typescript
{
  {apiKeyProperty}: { '{keyName}': 'API_KEY' }              // e.g. { 'X-Api-Key': '...' }
  // two-parameter scheme: { 'token': '...', 'api-key': '...' } — both required
}
```

## OAuth 2.0 — client credentials (machine-to-machine)

All OAuth fields are `oAuth`-prefixed (capital A). This grant gets **no `oAuthScopes`** unless its spec
declares scopes — check the credentials object in `src/configuration.ts` before passing one; an absent
field is a TS excess-property error.

```typescript
{
  {oAuthProperty}: {
    oAuthClientId: '...',
    oAuthClientSecret: '...',
  }
}
```

## OAuth 2.0 — authorization code (3-legged)

The 3-legged flow runs through the generated `{scheme}Manager` on the client, not through config
callbacks. There is no `pkce` field and no `onPromptForAuthorizationCode` hook. This is the grant that
normally carries `oAuthScopes` — typed to a generated scope enum, not `string[]`, whose members are
listed under `### Scopes` in this grant's `doc/auth/*.md`.

```typescript
{
  {oAuthProperty}: {
    oAuthClientId: '...',
    oAuthClientSecret: '...',
    oAuthRedirectUri: 'https://app.example.com/callback',
    oAuthScopes: [{ScopeEnum}.SomeScope],   // present only when the spec declares scopes
  }
}
```

The manager property exists only when `{oAuthProperty}` was supplied to the constructor, and is declared
optional when the SDK has more than one auth scheme — so guard it or use optional chaining:

```typescript
// 1. Send the user to the authorization URL (state is an argument, not a config field).
const url = client.{scheme}Manager?.buildAuthorizationUrl(state);

// 2. Exchange the code your redirect endpoint received.
const token = await client.{scheme}Manager?.fetchToken(authorizationCode);

// 3. Re-attach it — withConfiguration returns a NEW client.
if (token) {
  client = client.withConfiguration({
    {oAuthProperty}: { ...creds, oAuthToken: token },
  });
}
```

`client.{scheme}Manager?.refreshToken()` renews a token that carries a refresh token.

## OAuth 2.0 — resource owner password

```typescript
{
  {oAuthProperty}: {
    oAuthClientId: '...',
    oAuthClientSecret: '...',
    oAuthUsername: '...',
    oAuthPassword: '...',
  }
}
```

Like client-credentials, this grant gets `oAuthScopes` only where its spec declares scopes — read the
credentials object rather than copying the field in.

## Token caching & refresh (all OAuth2 grants)

The token is cached in memory on the client instance and refreshed lazily, in a request interceptor,
when it is missing or past its `expiry`. Nothing inspects a `401` — a `401` propagates as an `ApiError`.
If the token endpoint returns no `expires_in`, no `expiry` is recorded and the token is never
auto-refreshed.

Four lifecycle fields are emitted on **every** OAuth2 grant's credentials object:

- `oAuthToken` — seed or restore a previously persisted token.
- `oAuthTokenProvider: (lastOAuthToken, authManager) => Promise<Token>` — supply the token yourself;
  invoked whenever the cached token is missing or expired.
- `oAuthOnTokenUpdate: (token) => void` — fires on every token refresh; the hook for persisting it.
- `oAuthClockSkew` — seconds subtracted from expiry so the refresh happens early. Unset by default.

```typescript
{
  {oAuthProperty}: {
    oAuthClientId: '...',
    oAuthClientSecret: '...',
    oAuthOnTokenUpdate: (token) => saveTokenToDatabase(token),
    oAuthTokenProvider: async (lastOAuthToken, authManager) =>
      (await loadTokenFromDatabase()) ?? authManager.fetchToken(),
  }
}
```

To re-credential a live client, `client.withConfiguration({ {oAuthProperty}: { ...creds, oAuthToken } })`
— it returns a **new** client rather than mutating the existing one.

## Custom auth

A spec-defined custom scheme surfaces as `{customAuthProperty}?: any` — the type names no fields, and no
`doc/auth/*.md` page is generated for it. Its real shape and behaviour are in the generated
`customAuthenticationProvider` in **`src/authentication.ts`**: the provider's parameter type is the
credentials shape (`{}` when the scheme declares no parameters), and its interceptor body is everything
the scheme does to the request. As generated that body is a **pass-through that attaches nothing** — the
scheme satisfies the auth requirement but sends no credential, so a call that looks authenticated is not.

```typescript
{
  {customAuthProperty}: {},    // any truthy value; the provider is built only when this is set
}
```

Leave it unset and the requirement is unsatisfied — the composite provider throws before the request.
Read `customAuthenticationProvider` before relying on this scheme; if it is a pass-through, the credential
has to come from somewhere else (your own request handling, or a regenerated SDK).

## Combined / multiple schemes

An operation declares its requirements as an **array of maps**: the array is OR, each map is AND. At call
time the SDK picks the **first map whose every listed scheme has credentials configured** and applies
exactly those. It does not try a scheme and fall back on a `401`. If no map is fully satisfied it throws
a plain `Error` before the request is sent.

That pre-flight throw is skipped where the SDK generates a **fallback credentials object**: when a scheme
also has a deprecated bare-string field, the client builds a cloned config in which that scheme's
credentials default to `{ '<key>': config.<deprecatedField> || '' }`, and hands *that* to the auth
provider — so the scheme always counts as configured, and a client with no credentials at all sends an
**empty** credential and gets a remote `401` instead of failing locally. Grep `src/client.ts` for
`createAuthProviderFromConfig` and read the argument **that call** receives: `this._config` (the throw
fires) or a cloned object (the throw is suppressed). Presence of a `clonedConfig` in the constructor is
not the signal — a build may construct one purely to seed an OAuth manager and still hand `this._config`
to the auth provider, so read the call, not the nearest clone.

Consequence: configuring several OR alternatives is **not** belt-and-braces — only the first configured
one is ever sent, and the others are silently ignored. Configure just the scheme you intend to use.

The order is the one in the `req.authenticate([...])` call in the operation's method in
`src/controllers/`, mirrored by the `## Authentication` line in `doc/controllers/*.md`. The keys inside
those maps are the **scheme keys** from `src/authProvider.ts` — a camel-cased form of the scheme name in
the spec (`APIKeyHeader` → `aPIKeyHeader`, `oauth2` → `oauth2`). They are a different name from the
credentials property you set on `Configuration`, which is derived from the auth *type* (that same
`APIKeyHeader` scheme is configured through `customHeaderAuthenticationCredentials`), and they do not
follow the `oAuth`-prefixed spelling of the OAuth credential fields. Set credentials by the
`Configuration` property; use the scheme keys only to read which combinations an operation accepts.

## No auth

Some endpoints/APIs need no credentials — leave the credentials properties unset.

## Discovering what a specific SDK uses

1. Open the `Configuration` interface in `src/configuration.ts` and list its optional credentials
   properties — this is the **source of truth** for what the SDK accepts and for each scheme's inner
   field names. Do not derive a property name from the scheme name in the spec; they often differ.
2. `doc/auth/*.md` restates the same fields as a table (one row per required field), with a runnable
   snippet, plus a `### Scopes` table on grants that declare scopes. A custom scheme gets no page here.
3. `src/authentication.ts` is a re-export of the shared `@apimatic` auth adapters — plus, for a custom
   scheme, that SDK's own generated `customAuthenticationProvider`, which is the only place that scheme's
   credential shape and behaviour are visible.
