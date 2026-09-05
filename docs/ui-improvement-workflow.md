# UI improvement workflow

This workflow uses two independent AI review roles. It is not a study with human participants.

## Roles and order

1. **ui_ux_expert** inspects information hierarchy, typography, status semantics, color/contrast, icons, paths, density, responsive behavior, and accessibility. Cite official WCAG, WAI-ARIA APG, or MDN sources for standards-based recommendations. Separate observed defects from design hypotheses.
2. **usability_tester** initially sees only rendered UI, the accessibility tree, and user actions. Do not read product implementation or the expert proposal before submitting independent observations. Record task, steps, expected result, observed result, evidence, and limitations. After implementation, re-run acceptance criteria independently.
3. **Orchestrator** compares both reports, checks existing issues, creates issues with evidence and acceptance criteria, shares their links, and only then implements small changes. Keep the tester separate from implementation. Verify local behavior and exact remote CI/review revision before completion.

## Data boundary

Use invented task/session IDs, projects, paths, and messages. Do not publish private screenshots or send real user sessions to browser agents. Do not operate the installed service or real worker sessions. The synthetic harness must omit the production backend adapter and stub mutations locally. Distinguish UI behavior in the harness from real server integration.

## Reusable audit matrix

- Load: 10 parent tasks, 12 children under 3 parents, several external sessions.
- Content: ordinary Korean and English sentences; separately labeled unspaced overflow stress identifiers. Preserve exact source strings when submitting answers or copying paths.
- Surfaces: sidebar, cards, graph/minimap/zoom, details, Requests, messages, settings and controls.
- States: running, waiting for input, queued, error, cancelled, completed, archived; external Idle and Unknown remain distinct; empty and connection states.
- Viewports: desktop 1440, intermediate 1024, narrow 390 CSS pixels, light and dark.
- Operations: find task, inspect state and path, copy full path, answer question, submit follow-up, change state, navigate with keyboard, close/return focus.
- Measurements: element rectangles, scroll/client dimensions, clipping and intersection, accessible names, actual focus, target size, and contrast. Screenshot appearance alone does not prove interaction correctness.

## Issue contract

Include user impact, reproduction steps, before evidence, recommendation and alternative tradeoff, priority/dependencies, explicit acceptance criteria, and desktop/narrow/dark/keyboard/state-transition validation. Mark unexecuted or blocked checks as unverified. Do not infer missing functionality from a static screenshot.

## Delivery gates

Record fixture version and source revision. Run focused regression checks and required repository CI commands. Obtain independent after screenshots, DOM measurements, and operation results. Check remote CI and review on the actual PR head: a skipped review is not a completed review. Keep operational service upgrades and unrelated lifecycle issues separate.
