# ADR 003 — public contracts and two test gates
Status: accepted.

Schema, ports and behavior documentation are frozen together. UI/HTTP consumes application service through a composition root. Stubs throw NOT_IMPLEMENTED; only explicit demo path simulates success. Default verify tests implemented invariants and smoke only. Pending acceptance suites are executable and intentionally red, excluded by config rather than skip/todo. Each task must make its own suite green and add the listed missing cases. T12 replaces explicit temporary 501 and initial M0/not-implemented assertions with real readiness/behavior checks, preserving actual behavior checks.

Using schema inference avoids handwritten DTO drift. Tests are not evidence of AI quality; human scoring and live billing stay separate. No live model calls in normal test commands.
