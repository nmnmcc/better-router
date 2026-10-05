# Examples

Runnable TypeScript workspaces for the main Better Router flows. Build the workspace once, then start an example with provider credentials:

```sh
devenv shell -- yarn build
```

| Example    | Shows                                                        | Documentation                  |
| ---------- | ------------------------------------------------------------ | ------------------------------ |
| Quickstart | Chat Completions through an OpenAI Responses deployment      | [README](quickstart/README.md) |
| Failover   | Ordered OpenAI-to-Anthropic fallback behind one model alias  | [README](failover/README.md)   |
| SDK call   | In-process `runtime.generate` without an HTTP server         | [README](sdk-call/README.md)   |
| SQLite     | Injected SQL Layer, migrations, and restart-safe typed state | [README](sqlite/README.md)     |

Each example declares provider contracts, deployments, and model routes as
plugins. `Router.make` preflights those declarations; `Router.runtime` binds the
host's HTTP client and credential resolver within a Scope. HTTP ingress and SDK
calls share that runtime.

Examples use real credentials when launched manually. CI uses local fake
upstreams for host integration checks.
