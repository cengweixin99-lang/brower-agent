# contracts

Legacy capture DTOs remain at `@pba/contracts`. General Agent protocol version 1 is available at `@pba/contracts/runtime`: strict boundary parsers, task/run/step/action/observation types, pure lifecycle rules and recovery classification. No infrastructure dependencies or browser execution.

See [runtime contracts and migration plan](../../docs/runtime-contracts.md). Run `pnpm test:foundation` from the repository root. State helpers must be used under persistence transactions with trusted service facts; parsing is not authorization.
