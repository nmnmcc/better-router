# Repository Guidelines

## Conventions

- Layout: follow `references/effect/` for package and module organization; expose PascalCase modules directly from each package's `src/` and `src/index.ts`, without an additional `internal/` layer.
- TypeScript: two spaces, double quotes, no semicolons, `import type` for type-only imports, `.js` suffixes on relative imports. Follow adjacent code; treefmt is configured for formatting.
- Plugins: declare deployments, routing, transforms, and HTTP APIs/handlers at router creation; no separate gateway plugin.
- Functional style: all owned production code, examples, tests, scripts, and build configuration use `const`, expressions, immutable collection operations, and pure reducers. Never use `for`, `for...of`, `for...in`, `for await`, `while`, `do`, `let`, `var`, reassignment, increment/decrement, property assignment, or mutating operations such as `push`, `splice`, native `Map.set`, and `Object.assign`. `map`, `reduce`, and `forEach` may not mutate captured state; sequence item effects with `Effect.forEach`, and accumulate stream state immutably. Effect's immutable `HashMap.set` and scoped, atomic `Ref` updates at host/test boundaries are distinct from in-place mutation.
- Parse, don't validate: decode each untrusted protocol, configuration, and event boundary with a Schema before projecting semantics. Keep Schema issue paths; reject unportable semantics with Schema-backed structured errors. Use `Option` for internal absence, `Result` for fallible pure conversions and deployment construction, and `Effect`/`Stream` for I/O, resources, and concurrency. Domain functions do not define classes, throw, run Promises, read clocks, or perform I/O. Public model types are deeply readonly; do not recursively freeze runtime objects.

## Commands

Always run project commands in `devenv` (`devenv shell -- <command>`) to keep the development environment reproducible and idempotent.

- `devenv shell -- yarn install --immutable`: install from the lockfile.
- `devenv shell -- yarn check`: build, compile projects and tests, then run type and runtime tests.
- `devenv shell -- yarn build`: emit output to ignored `dist/` directories.
- `devenv shell -- yarn generate:openresponses --check`: verify pinned generated types and runtime Schema source.

## Tests

- Testing: when changing contracts, Effect workflows, HTTP endpoints, or examples, read [docs/testing.md](docs/testing.md) and run the relevant checks.
- Review changed files for forbidden syntax and captured-state mutation; no automatic syntax gate is installed. Cover Schema decode/encode and field paths, pure input preservation, subscription-local stream state, and cancellation when touching those boundaries.

## Commits & Pull Requests

- Use scoped, imperative subjects, e.g. `core: define routing errors`.
- PRs: describe changed contracts or behavior, link relevant issues, report `check` and `build` results.
- Update `docs/architecture.md` when router or plugin contracts change.
