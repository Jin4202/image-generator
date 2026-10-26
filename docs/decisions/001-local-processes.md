# ADR 001 — local API + durable worker
Status: accepted, 2026-10-26.

Use one Next.js Node server, one tsx worker and one SQLite file. Reject Redis/remote queues for MVP. HTTP writes draft; worker alone submits provider calls. SQLite lease + submitting intent protects against duplicate automatic paid requests. A crash between external submit and saving request ID is inherently ambiguous: mark submission_unknown and require explicit resolution. Do not promise exactly-once delivery. Poll/download may retry independently of submit. Trade-off: local computer must remain running; pending jobs resume when worker restarts.
