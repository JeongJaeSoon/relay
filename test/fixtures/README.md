# Test fixtures

Every file in this directory is a versioned synthetic baseline. It may preserve a protocol shape or an edge case, but it must not be copied from a user conversation, live database, incident log, transcript, account, or local machine.

Use invented IDs, `/workspace/...` paths, neutral project names, and example-only task text. Keep the smallest fields needed to exercise the contract. `capabilities.json` is a synthetic gate contract, not a CLI capture; `peer-frames.json` preserves the public protocol envelope with invented sockets and IDs.

Before adding or changing a fixture, reviewers must confirm:

- the source is synthetic or a public specification with its citation recorded in the change;
- no personal path, account, company/project identifier, secret, live prompt, output, or incident text remains;
- the documented edge case still has a direct test; and
- a proposed transcript, live DB, or incident capture has explicit public-use approval and a separate provenance record before it can be considered.

Current-tree cleanup does not rewrite Git history. If a sensitive historical value is found, record its scope and decide history remediation separately.
