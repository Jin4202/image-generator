# ADR 002 — versioned JSON aggregates + immutable blobs
Status: accepted.

Drizzle describes per-entity SQLite tables, each body validated by public Zod schema. Indexed identity keys are duplicated into explicit columns; repository owns consistent mapping. Foreign keys cover project ownership and major generation relations; services check internal JSON references in transaction. This keeps prototype layout/style evolution simple while sacrificing rich SQL analytics. Numbered SQL migrations are checksum-protected; no drizzle-kit is required.

Approved asset/style updates create new versions. Run snapshots, candidate/media/preview are immutable. Revision lineage is parentCandidateId + snapshot.edit, not a redundant Revision table. Blob write precedes DB commit; orphan files allowed, garbage collection deferred. Export currently produces PNG and manifest, not a portable archive containing all images.
