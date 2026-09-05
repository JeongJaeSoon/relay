# Unknown-spawn close guard — in progress

Follow-up to the cleanup work in PR #53. A production HTTP/dispatcher/outbox reproduction created a roster row, then lost the spawn result before Relay recorded any identity. Close produced `closed` with one live roster row and zero process records.

The next bounded fix always performs close's stop preflight, including tasks with no identity. If an attempted spawn has matching roster candidates but ownership is unresolved, close stays visible and its stop command is unknown/retryable; no candidate is automatically stopped based on its name. When the delayed authenticated SessionStart establishes identity, Retry cleanup stops and removes the owned row. Both stages are covered by the integration test.

Validation so far: typecheck and full suite 376 pass / 2 opt-in skip / 0 fail; a further integration assertion verifies delayed-hook convergence. This follow-up is not yet a merged change or complete #37 acceptance. Durable missing-hook adoption, candidate renaming/delayed roster publication, generation enrichment, and full ownership invariants still require implementation and real QA.
