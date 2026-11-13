# persistence

Legacy capture persistence remains at `@pba/persistence`. `@pba/persistence/runtime` adds versioned/checksummed migrations, durable task/run state, exclusive browser sessions, idempotent stop commands, transactional events and an outbox. New and legacy execution share one local browser slot.

See [P03 lifecycle and recovery semantics](../../docs/runtime-sessions.md). Run `pnpm test:sessions` with the local database available. The outbox dispatcher is a later milestone; expired/orphaned sessions cannot be reclaimed without confirmed browser isolation.

P04 migration 2 adds observation snapshots, screenshot metadata and the latest observation pointer. Their transaction validates current ownership, epoch, lease, running state and increasing sequence. Historical observations remain readable after stop; they are evidence, not live browser references. See [observation persistence](../../docs/runtime-observations.md).

P05 migration 3 adds the action ledger: durable admission, request fingerprints and immutable receipts. Admission serializes with stop; unresolved or unknown actions prevent further actions. Duplicate IDs replay results, including after reconnect, without issuing another browser command. See [action semantics](../../docs/runtime-actions.md).
