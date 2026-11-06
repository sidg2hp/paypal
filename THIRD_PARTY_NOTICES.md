# Third-party notices

This repository is MIT licensed (see [LICENSE](LICENSE)). The following
third-party assets are included with their own licenses and attribution.

## AG Grid Community 36.3.0

- **Files:** `public/vendor/ag-grid/ag-grid-community.min.js`,
  `public/vendor/ag-grid/ag-theme-quartz.min.css`,
  `public/vendor/ag-grid/LICENSE.txt`
- **License:** MIT
- **Source:** <https://www.npmjs.com/package/ag-grid-community/v/36.3.0>
- **Use:** the receivables ledger (sorting, custom cell renderers, row click).
- **Modifications:** none to the library; the app configures the grid in
  `public/app.js`.

The vendored copy keeps the demo runnable offline. AG Grid is a trademark of
AG Grid Ltd.; it is used here only to describe the integration.

## PayPal Server SDK Context Plugin (APIMatic)

- **Files:** `docs/apimatic/paypal-context-plugin/` (TypeScript skills, README,
  plugin manifest)
- **License:** MIT (declared in the plugin's `plugin.json`)
- **Source:** <https://github.com/paypaldev/server-sdk-context-plugin-preview>
- **Use:** vendor-inspectable copy of the official context plugin installed with
  `npx context-plugins install`. It documents the APIMatic-generated PayPal
  Server SDK for coding agents.
- **Modifications:** the vendored copy is restricted to the TypeScript skills
  relevant to this Node.js project; the content itself is unchanged.

The plugin README notes it is a hackathon preview, not a long-term supported
PayPal product.

## Runtime dependencies

None. The application, tests, and scripts use only Node.js built-in modules.

## Development-time tools

The following were used during development but are not vendored and are not
required to run the project: Node.js, Redocly CLI (OpenAPI linting),
`@apimatic/cli` (documented, authentication required), Chrome headless
(screenshots), and the PayPal Developer Sandbox.

## Trademarks

PayPal and the PayPal logo are trademarks of PayPal, Inc. They are used only to
describe the integration. No PayPal logo assets are redistributed in this
repository.

## Assets

`docs/assets/dashboard.png` and `docs/assets/pay-page.png` are screenshots of
this project's own UI with synthetic data. No third-party imagery is included.
