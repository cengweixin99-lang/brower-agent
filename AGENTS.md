# Development rules

- Use pnpm 11.25.0 and Node 24. Direct external dependencies must use exact versions.
- Install dependencies with pnpm install --ignore-scripts. Review lifecycle scripts before enabling any.
- Read files fully before editing. Use strict, erasable TypeScript and top-level imports; avoid any.
- Run pnpm check after code changes. Run changed tests directly; do not make paid provider calls by default.
- Keep browser execution behind the browser-worker gateway. The agent package must not import Playwright.
- Temporal workflows contain deterministic orchestration only; perform I/O in activities.
- Never store credentials, cookies, prompts containing secrets, or session profiles in Git.
- Do not modify unrelated files, reset the worktree, or commit unless requested.
