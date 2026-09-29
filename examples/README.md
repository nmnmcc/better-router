# Examples

This directory groups example workspaces. Each example lives in its own subdirectory with a `package.json`; the root `examples/*` workspace pattern includes it automatically.

## Guided examples

These examples are small, real-provider applications that can be copied into a local project:

| Example                              | What it shows                                                     | Start command                                            |
| ------------------------------------ | ----------------------------------------------------------------- | -------------------------------------------------------- |
| [`quickstart`](quickstart/README.md) | Chat Completions ingress backed by an OpenAI Responses deployment | `yarn workspace @better-router/example-quickstart start` |
| [`failover`](failover/README.md)     | Ordered OpenAI-to-Anthropic fallback behind one model alias       | `yarn workspace @better-router/example-failover start`   |
| [`sdk-call`](sdk-call/README.md)     | In-process semantic `router.invoke` and response completion       | `yarn workspace @better-router/example-sdk-call start`   |

The guided examples expect real provider credentials. They are compiled by the project references but are not run by CI against a live provider.
