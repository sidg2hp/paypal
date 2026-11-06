# APIMatic integration

Cashflow Copilot uses APIMatic in two concrete ways:

1. **A machine-readable API contract** — [`openapi/openapi.yaml`](../openapi/openapi.yaml)
   and its JSON twin describe every route, schema, error, and PayPal webhook
   header. The spec is the source of truth for the API, not a post-hoc diagram.
2. **PayPal's APIMatic context plugin** — the official
   `server-sdk-context-plugin-preview` was installed and its TypeScript skills
   are vendored under [`apimatic/paypal-context-plugin/`](apimatic/paypal-context-plugin/)
   so a judge can inspect exactly what the coding agent was given. It grounds
   PayPal Server SDK facts (authentication, client initialization, calling
   endpoints, error handling, testing) instead of relying on model memory.

## What is in this repository

| Artifact | Path | Purpose |
| --- | --- | --- |
| OpenAPI 3.1 contract | `openapi/openapi.yaml` | Human-readable API contract |
| OpenAPI JSON | `openapi/openapi.json` | Import format for APIMatic and other tools |
| APIMatic build file | `openapi/APIMATIC-BUILD.json` | Portal/SDK build configuration |
| PayPal context plugin (vendored, MIT) | `docs/apimatic/paypal-context-plugin/` | Judge-inspectable copy of the installed TypeScript skills |
| Validation evidence | this document | Commands run and their results |

## Commands that were actually run

Install the official PayPal context plugin (no APIMatic account needed):

```sh
npx context-plugins install https://github.com/paypaldev/server-sdk-context-plugin-preview
```

Result: installed into Claude Code, VS Code, and Codex at user scope. The
TypeScript skill set was copied into this repository with its original MIT
licence and attribution so the judge does not need to install anything.

Validate the OpenAPI description offline with Redocly:

```sh
npx @redocly/cli lint openapi/openapi.yaml
```

Result:

```text
openapi/openapi.yaml: validated in 108ms
Woohoo! Your API description is valid.
You have 18 warnings.
```

The warnings are all `operation-4xx-response` style suggestions; there are zero
validation errors.

APIMatic's own CLI validation and SDK generation require an APIMatic account
(the hackathon offers one free month of Basic). The exact commands are:

```sh
# Requires: npx @apimatic/cli (Node >= 22.14) and `apimatic auth login`
apimatic api validate --file=openapi/openapi.yaml
apimatic api transform --format=OpenApi3Json --file=openapi/openapi.yaml
apimatic sdk generate --language=typescript --input=. --destination=./sdk/typescript
apimatic portal serve --open
```

`openapi/` is laid out as an APIMatic build directory (spec plus
`APIMATIC-BUILD.json`), so the last two commands can be run from the repository
root after authentication. The generated SDK is intentionally **not** committed:
it would be a large generated artifact and the account-bound step cannot be
reproduced by a judge. The contract, the build file, and the validation output
are the reviewable artifacts.

## How the plugin changed the implementation

The context plugin's TypeScript skills were used as the reference while writing
`src/core.js` and `src/server.js`. Concretely:

- **Authentication** — OAuth 2.0 client-credentials at `/v1/oauth2/token`, with a
  cached token and a bounded timeout (`PayPalSandboxAdapter.accessToken`).
- **Calling endpoints** — Invoicing v2 paths for create/send/remind/cancel/read,
  and Orders v2 paths for create/capture.
- **Error handling** — PayPal failures are converted to a single `PAYPAL_ERROR`
  API error; provider responses and secrets are never logged.
- **Models** — invoice items, per-item tax, payment terms, and the checkout
  purchase unit are built explicitly instead of passing untrusted JSON through.

This is why the PayPal integration is small and direct: the plugin gave the
agent the SDK's actual contract, and the app uses the documented REST surface
without a runtime dependency.

## Honest boundaries

- The OpenAPI description describes **this application's** API. The PayPal APIs
  it calls are described by PayPal's own specs, not re-published here.
- The context plugin is a hackathon preview and is not an official long-term
  PayPal product (its README says so). The vendored copy is MIT-licensed.
- SDK generation is documented but not committed; see above.

## Sponsor form note

If this project is submitted for the APIMatic sponsor prize, select **APIMatic**
on the Devpost submission form. Being present in the repository is not enough to
be considered for a sponsor award.
