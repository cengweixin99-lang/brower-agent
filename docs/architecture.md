# Architecture

web -> api -> Temporal workflow -> activity -> pi agent -> browser-worker gateway -> Playwright

- apps are independently deployable processes; packages are internal workspace libraries.
- pi-ai and pi-agent-core are pinned to 1.5.1. This project does not depend on the local pi source checkout.
- The current worker only runs environmentCheck. Browser task orchestration is not implemented.
- Browser-worker currently exposes health only. Add authenticated gateway contracts, exclusive leases, policy checks, and an action ledger before exposing browser actions.
- Activity retry must reconcile uncertain actions instead of repeating external side effects.
- Provider credentials, cookies, screenshots, and session data must stay out of Git.
