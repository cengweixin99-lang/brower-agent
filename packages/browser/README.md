# browser

Playwright exports and `BrowserSessions`, an in-memory owner of persistent contexts and pages used only by browser-worker. Session open is idempotent and close also cancels a pending initial navigation. Durable admission, leases, network policy and release acknowledgement are enforced by the gateway and persistence layer.

P04 adds bounded page/frame observations, viewport screenshots and live element reference validation. Navigations, observed DOM mutations and hidden targets invalidate references; historical snapshots cannot restore live handles. P05 adds native browser actions through the gateway, with live target validation and bounded execution. Page scripts and network writes remain disabled; form submission is denied. `pnpm test:sessions` exercises real Chromium exclusively through the gateway. See [sessions](../../docs/runtime-sessions.md), [observations](../../docs/runtime-observations.md) and [actions](../../docs/runtime-actions.md).
