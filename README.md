# Better Router

Effect-based, type-first LLM router workspace. Chat Completions, OpenAI Responses and Anthropic Messages can each serve HTTP requests and execute an upstream deployment; the original Chat-to-Responses gateway remains runnable.

The application is configured once with model routes and a list of declarative plugins. The same configured router serves in-process SDK calls and, when plugins contribute HTTP endpoints, a hosted HTTP application. There is no gateway plugin or imperative plugin registry.

| Package                                         | Responsibility                                                                                         |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `@better-router/core`                           | OpenResponses IR, deployments, routing, transforms, HTTP composition, and declarative plugin contracts |
| `@better-router/plugin-openai-chat-completions` | Chat Completions HTTP ingress and upstream executor                                                    |
| `@better-router/plugin-openai-responses`        | Responses HTTP ingress and upstream executor                                                           |
| `@better-router/plugin-anthropic-messages`      | Anthropic Messages HTTP ingress and upstream executor                                                  |

Packages are flat under `packages/`, with plugins named `plugin-{creator}-{protocol}`. Like Effect, each package exposes focused modules by name from its root and by subpath: `@better-router/core` exposes `Conversion`, `Model`, `ModelEvents`, `ModelSchema`, `OpenResponses`, `Deployment`, `Routing`, `Transform`, `Http`, `Plugin`, and `Router`. Each protocol plugin exposes its conversion, HTTP and plugin modules. Nine independently runnable workspaces live under [examples/matrix](examples/matrix/README.md).

Each `Plugin.make` can declare an authenticated HTTP ingress, deployments, or both. The SDK calls `router.open`, `router.stream`, or `router.complete` directly; a server host serves `router.http.routes` with Effect's `HttpRouter`. There is no separate gateway plugin or protocol-bypass path.

The canonical request, event stream, and full response follow [OpenResponses 2026-04-24](https://www.openresponses.org/specification); `yarn generate:openresponses` regenerates the pinned types. See [Architecture](docs/architecture.md) for the proposed interfaces, lifecycle, and routing rules, and [Context](CONTEXT.md) for the terms used here.

All three ingresses convert to the OpenResponses request IR. `Router.make` validates and composes deployments, routing policies, transforms, and HTTP fragments. Each deployment reads an upstream SSE stream through Effect `HttpClient`, even when the caller requested JSON. See [Architecture](docs/architecture.md) for the supported portable subset and explicit rejections.

Build the library dependency and run the TypeScript example workspace with `tsx`, using a private upstream key and a separate key for clients:

```sh
devenv shell -- yarn build
OPENAI_API_KEY=your-upstream-key GATEWAY_API_KEY=your-client-key OPENAI_MODEL=your-responses-model devenv shell -- yarn workspace @better-router/example-chat-completions-gateway start
```

It listens on `127.0.0.1:8787` at `POST /v1/chat/completions`. Clients send `Authorization: Bearer your-client-key` and a Chat Completions JSON body. Optional `GATEWAY_MODEL` selects a public alias, `GATEWAY_PORT` / `GATEWAY_HOST` configure the listener, and `OPENAI_RESPONSES_URL` selects a trusted full upstream Responses URL. See [protocol adapters](docs/architecture.md#protocol-adapters).

Library packages build with tsdown to ESM-only `.mjs` entries, `.d.mts` declarations, and source maps. Root and PascalCase subpath exports resolve to `dist/`; the example package runs TypeScript directly with `tsx` and participates in project-reference type checking. TypeScript project references write intermediate declarations to ignored `.types/` directories. Yarn 4 manages the workspace.

```sh
devenv shell -- yarn install --immutable
devenv shell -- yarn check
devenv shell -- yarn build
```

Run `devenv shell -- treefmt` to format project files, or `devenv shell -- treefmt --ci` to fail if formatting changes are needed (`--ci` also writes those changes). The configuration excludes vendored `references/` projects and lockfiles.

Runtime and type contracts live beside each package in `test/` and `typetest/`; cross-package type checks live in the root `typetest/`, and the gateway host test lives with its example. See [Testing](docs/testing.md) for conventions and focused commands. `devenv shell -- yarn check` builds and runs all type and runtime tests without a live provider key; `devenv shell -- yarn test:coverage` generates a local report.
