# Local infrastructure

PostgreSQL and Temporal are development services, bound to loopback only. Compose configuration is generated with pinned image digests during initialization. Persistent data lives in project-scoped Docker volumes. pnpm infra:down preserves those volumes. Production authentication, TLS, backup, network policy, and deployment are not configured here.
