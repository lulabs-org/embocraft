# Test layout

- Keep focused unit tests beside the source they cover, using the same basename (`foo.ts` → `foo.test.ts`).
- Split independent cases by their owning source file. Keep cases that verify a shared contract or lifecycle across modules in the owning app or package's `test/` directory.
- Keep repository-wide architecture and baseline checks here. Shared fixtures live in `support/`, and benchmarks live in `benchmarks/`.
- Run all Vitest tests with `pnpm test`; the package and app builds do not run them.
