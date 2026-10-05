# SQLite persistence

This host injects `@effect/sql-sqlite-node` into the optional
`@better-router/persistence-sql` companion. The router runs the plugin's typed
Schema migration before `init`; the initializer increments a namespaced state
record, so restarting the process preserves the run count while deployment
health and usage remain in the same persistence boundary.

```sh
devenv shell -- yarn build
OPENAI_API_KEY=provider OPENAI_MODEL=gpt-5-mini \
  devenv shell -- yarn workspace @better-router/example-sqlite start
```

Set `OPENAI_RESPONSES_URL` for a compatible endpoint and
`BETTER_ROUTER_SQLITE` for a different SQLite file. The SQLite driver is a host
dependency; core only defines the persistence ports and typed declarations.
