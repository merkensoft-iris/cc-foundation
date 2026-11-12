# Architecture decision records

One file per decision, `NNNN-short-title.md`, numbered from 0001 and never reused. Start
from [0000-template.md](0000-template.md). P0 spikes file their results here
(docs/design/09-build-plan.md §5; 08 §7 `cc-spike-report`).

## Rules

1. An ADR lands through a PR like any other change. It merges with status `accepted` (or
   `rejected`, when the record is worth keeping).
2. An accepted ADR is not rewritten. A later decision that changes it is a new ADR, and the
   old one's status becomes `superseded by NNNN` in the same PR.
3. If a decision changes the design, the ADR says which documents change and the PR that
   changes them.

## Numbers

Numbers 0001 to 0005 are reserved for the spikes of gate P0, which run in parallel, so
their PRs do not collide. Any other ADR takes the next free number above the highest one
on `main`; if two open PRs take the same number, the one merged later renumbers.

| Number | Task  | Subject                                                  | Status   |
| ------ | ----- | -------------------------------------------------------- | -------- |
| 0001   | P0-03 | Recurrence and time-zone libraries                       | accepted |
| 0002   | P0-08 | [S5 Local API and CLI](0002-local-api-and-cli.md)        | accepted |
| 0003   | P0-10 | [S6 Engine extension API](0003-engine-extension-api.md)  | accepted |
| 0004   | P0-11 | S7 Clean-tree start                                      | accepted |
| 0005   | P0-13 | S9 Harness deny rules                                    | accepted |
| 0006   | P0-12 | [S8 Verifiable packages](0006-s8-verifiable-packages.md) | accepted |
