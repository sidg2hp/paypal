**NOTE: This repo holds the Server SDK Context Plugin for the hackathon. It is not an official long term supported PayPal product and may be removed at any time.**

# PayPal Server SDK Plugin

A plugin whose skills teach a coding agent to install and use the APIMatic-generated **PayPal Server SDK**, in csharp, java, php, Python, ruby, TypeScript. Every SDK fact the skills state is grounded in the SDK's own source and generated documentation, not in what a model remembers about this API.

## What's inside

One skill set per language. The entry point is that language's getting-started skill, which carries what is specific to this SDK; the rest are API-agnostic and describe how to use any SDK the same generator produces.

| Language | Skill prefix | Skills |
| --- | --- | --- |
| csharp | `csharp-` | `csharp-authentication`, `csharp-calling-endpoints`, `csharp-client-initialization`, `csharp-configuration-resilience`, `csharp-error-handling`, `csharp-getting-started`, `csharp-models`, `csharp-testing` |
| java | `java-` | `java-authentication`, `java-calling-endpoints`, `java-client-initialization`, `java-configuration-resilience`, `java-error-handling`, `java-getting-started`, `java-models`, `java-testing` |
| php | `php-` | `php-authentication`, `php-calling-endpoints`, `php-client-initialization`, `php-configuration-resilience`, `php-error-handling`, `php-getting-started`, `php-models`, `php-testing` |
| Python | `python-` | `python-authentication`, `python-calling-endpoints`, `python-client-initialization`, `python-configuration-resilience`, `python-error-handling`, `python-getting-started`, `python-models`, `python-testing` |
| ruby | `ruby-` | `ruby-authentication`, `ruby-calling-endpoints`, `ruby-client-initialization`, `ruby-configuration-resilience`, `ruby-error-handling`, `ruby-getting-started`, `ruby-models`, `ruby-testing` |
| TypeScript | `typescript-` | `typescript-authentication`, `typescript-calling-endpoints`, `typescript-client-initialization`, `typescript-configuration-resilience`, `typescript-error-handling`, `typescript-getting-started`, `typescript-models`, `typescript-testing` |

## Install

Install the plugin with a single command:

```
npx context-plugins install https://github.com/paypaldev/server-sdk-context-plugin-preview
```

Then ask a usage question (e.g. *"how do I authenticate this SDK with an API key?"*) to trigger the relevant skill.

