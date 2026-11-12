# Environment validation

Validated on 2026-11-12 (Asia/Shanghai), Windows, Node 24.22.1, pnpm 11.25.0.

| Check               | Result                                                                   |
| ------------------- | ------------------------------------------------------------------------ |
| pnpm check          | Passed: exact direct dependency versions, Biome, TypeScript              |
| pnpm smoke:pi       | Passed: pi-ai and pi-agent-core initialize offline                       |
| pnpm smoke:browser  | Passed: Chromium launch, label lookup, input, click, result verification |
| pnpm smoke:infra    | Passed: PostgreSQL query and Temporal namespace                          |
| pnpm smoke:workflow | Passed: environmentCheck workflow and activity                           |
| pnpm smoke:http     | Passed: API, browser-worker, Vite HTTP endpoints                         |
| pnpm smoke:web      | Passed: React render, service proxies, no page errors                    |

Browser screenshot: .data/screenshots/dev-home.png (ignored by Git).

PostgreSQL uses 127.0.0.1:55433 because 55432 was already occupied. Existing services were preserved.
Browser binaries and temporary files use this project's .data directory on E:. Only the two browser caches created during this initialization were moved from C: to E:.
Docker images are pinned by digest. The Temporal volume initializer sets ownership for the non-root server process. Both data volumes persist across pnpm infra:down.

No provider requests were made. No model credentials were configured. Git was initialized without commits.

## Known upstream diagnostics

The Temporal worker dependency chain emits Node DEP0176 (fs.F_OK deprecation) during startup. It did not prevent bundling or workflow execution. This warning is not suppressed. Dependency installation also reports deprecated transitive node-domexception@1.0.0. These upstream diagnostics should be reviewed during dependency upgrades.

## Implementation status

This is a local development environment. The API and browser-worker expose health endpoints only. The worker runs an environment-check workflow. Browser task execution, authorization, durable action reconciliation, human takeover, and production deployment remain to be implemented.
