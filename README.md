# Better Router

Effect-based, type-first LLM router workspace. Chat Completions, OpenAI Responses and Anthropic Messages can each serve HTTP requests and execute an upstream deployment.

The application is configured once with model routes and a list of declarative plugins. The same configured router serves in-process SDK calls and, when plugins contribute HTTP endpoints, a hosted HTTP application. There is no gateway plugin or imperative plugin registry.

| Package                                         | Responsibility                                                                                                                                               |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `@better-router/core`                           | Capability catalog, direct pipelines, projections, execution lifecycle, deployments, routing, middleware, HTTP composition, and declarative plugin contracts |
| `@better-router/plugin-openai-chat-completions` | Chat Completions HTTP ingress and upstream executor                                                                                                          |
| `@better-router/plugin-openai-responses`        | Responses HTTP ingress and upstream executor                                                                                                                 |
| `@better-router/plugin-anthropic-messages`      | Anthropic Messages HTTP ingress and upstream executor                                                                                                        |

Packages are flat under `packages/`, with plugins named `plugin-{creator}-{protocol}`. Like Effect, each package exposes focused modules by name from its root and by subpath: `@better-router/core` exposes `Capability`, `Catalog`, `Pipeline`, `Execution`, `Lifecycle`, `Generation`, `GenerationSchema`, `GenerationEvents`, `Projection`, `Runtime`, `Ingress`, `Registry`, `Services`, `Conversion`, `Deployment`, `Routing`, `Middleware` (through `Pipeline`), `Http`, `Plugin`, and `Router`. The OpenAI Responses wire types and schemas belong to `@better-router/plugin-openai-responses`; each protocol plugin owns its conversion, HTTP and plugin modules.

Each `Plugin.make` declares an authenticated HTTP ingress, deployments, direct pipelines, protocol projections, and any required resources. SDK callers use `router.invoke` with a semantic command; a server host serves `router.http.routes` with Effect's `HttpRouter`. Same-protocol requests may use a declared direct pipeline and return an opaque response; otherwise the ingress selects the registered projection and enters the semantic generation pipeline. A protocol command never carries a conversion closure from the caller. Start with the [guided examples](examples/README.md) for a real-provider gateway, cross-provider fallback, or in-process SDK call.

The canonical request, event stream, and full response follow [OpenResponses 2026-04-24](https://www.openresponses.org/specification); `yarn generate:openresponses` regenerates the pinned types. See [Architecture](docs/architecture.md) for the proposed interfaces, lifecycle, and routing rules, and [Context](CONTEXT.md) for the terms used here.

Cross-protocol ingresses use a generation projection command. Same-protocol direct pipelines keep the original JSON/SSE body and only replace the routed private model. Define a router in two stages: `Router.make({ plugins })({ routes })` captures plugin declarations and their types before routes are written; `Router.layer({ plugins })({ routes })` provides the equivalent Layer constructor. Both forms validate and compose deployments, pipelines, routing policies, middleware, projections, and HTTP fragments. See [Architecture](docs/architecture.md) for the supported portable subset and explicit rejections.

The guided examples are runnable TypeScript workspaces. Build the library dependencies, then follow [the guided example instructions](examples/README.md):

```sh
devenv shell -- yarn build
GATEWAY_API_KEY=client OPENAI_API_KEY=provider OPENAI_MODEL=gpt-model \
  devenv shell -- yarn workspace @better-router/example-quickstart start
```

Library packages build with tsdown to ESM-only `.mjs` entries, `.d.mts` declarations, and source maps. Root and PascalCase subpath exports resolve to `dist/`. TypeScript project references write intermediate declarations to ignored `.types/` directories. Yarn 4 manages the workspace.

```sh
devenv shell -- yarn install --immutable
devenv shell -- yarn check
devenv shell -- yarn build
```

Treefmt is configured through Devenv's `treefmt-nix` integration in `devenv.nix`. The shell command and generated pre-commit hook use the same formatter graph. Run `devenv shell -- treefmt` to format project files, or `devenv shell -- treefmt --ci` to verify the tree. Vendored `references/`, lockfiles, and pinned generated OpenResponses artifacts are excluded; run `devenv shell -- yarn generate:openresponses --check` for the generated artifacts. Entering `devenv shell` installs a pre-commit hook that checks staged files; run `devenv test` to verify the hook.

Runtime and type contracts live beside each package in `test/` and `typetest/`; cross-package type checks live in the root `typetest/`. See [Testing](docs/testing.md) for conventions and focused commands. `devenv shell -- yarn check` builds and runs all type and runtime tests without a live provider key; `devenv shell -- yarn test:coverage` generates a local report.
