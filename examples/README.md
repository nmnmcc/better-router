# Examples

Runnable TypeScript workspaces for the main Better Router flows. Build the workspace once, then start an example with provider credentials:

```sh
devenv shell -- yarn build
```

| Example    | Shows                                                       | Documentation                  |
| ---------- | ----------------------------------------------------------- | ------------------------------ |
| Quickstart | Chat Completions through an OpenAI Responses deployment     | [README](quickstart/README.md) |
| Failover   | Ordered OpenAI-to-Anthropic fallback behind one model alias | [README](failover/README.md)   |
| SDK call   | In-process `router.generate` without an HTTP server         | [README](sdk-call/README.md)   |

Examples use real provider credentials and are not run against live providers in CI.
