# evals/runner

The model-driven evaluation runner is scheduled for P10 and is not implemented yet. P02 supplies controlled task definitions, fixtures and graders, exercised by `pnpm test:foundation` without provider calls.

The future runner must create an isolated fixture attempt, send only goal/start URL through the product API, wait for execution to quiesce, gather trusted browser/fixture evidence, and run the grader. Reports must identify model, prompt, protocol and policy versions, costs, failures and intervention rates. A paid-provider run requires explicit enablement; fixture tests must never be reported as model success rates.
