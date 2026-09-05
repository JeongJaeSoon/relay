# Unknown-spawn close guard — in progress

Follow-up to the cleanup work in PR #53. A production HTTP/dispatcher/outbox reproduction created a roster row, then lost the spawn result before Relay recorded any identity. Close produced `closed` with one live roster row and zero process records.

The next bounded fix always performs close's stop preflight, including tasks with no identity. If an attempted spawn has matching roster candidates but ownership is unresolved, close stays visible and its stop command is unknown/retryable; no candidate is automatically stopped based on its name. When the delayed authenticated SessionStart establishes identity, Retry cleanup stops and removes the owned row. Both stages are covered by the integration test.

Validation so far: typecheck and full suite 376 pass / 2 opt-in skip / 0 fail; a further integration assertion verifies delayed-hook convergence. This follow-up is not yet a merged change or complete #37 acceptance. Durable missing-hook adoption, candidate renaming/delayed roster publication, generation enrichment, and full ownership invariants still require implementation and real QA.

## Real Claude reproduction

A second isolated server ran on port 8807 with its own home/logs/binary. The QA runner started a real Claude 2.1.261 worker, deliberately withheld injected hooks, then discarded the successful launcher result. Task `0e2fd936-b15d-412a-b895-0b960423aaa3` had no IDs/process records while native roster row `d2b89f60-7c24-4c74-b69d-5b3d123f2ac2` existed. The worker prompt prohibited tool use and file changes.

Close stayed `error` with an unknown stop naming the candidate; it did not stop or remove a row on name alone. The QA harness then replayed an authenticated SessionStart for that exact real session through HTTP, using its recorded generation and worktree. Retry cleanup converged after that identity evidence. This is deliberate hook-delay injection, not a claim that the native CLI naturally delayed its hook in this run.
