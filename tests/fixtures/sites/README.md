# tests/fixtures/sites

`createDemoFixture()` in `demo.ts` serves synthetic office pages, a filterable catalogue and a contact form on a random loopback port. Create isolated attempts using a case ID from `evals/tasks/demo.ts`, pass the start URL to the future Agent runner, and collect server evidence through the in-process `evidence()` method. Always close the fixture after use.

Run `pnpm test:foundation` from the repository root. Current checks validate HTTP routes, browser-script syntax, attempt isolation and graders; they do not claim autonomous browser completion. General browser interaction will be tested through the gateway in P05/P10. Fixture network access must use an explicit test-only origin allowance.
