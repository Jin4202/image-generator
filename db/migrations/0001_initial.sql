-- Immutable baseline; add a numbered migration for any subsequent change.
CREATE TABLE projects (id TEXT PRIMARY KEY NOT NULL,
revision INTEGER NOT NULL CHECK(revision >= 0),
body TEXT NOT NULL CHECK(json_valid(body))
);
CREATE TABLE media (id TEXT PRIMARY KEY NOT NULL,
project_id TEXT NOT NULL REFERENCES projects(id),
revision INTEGER NOT NULL CHECK(revision >= 0),
body TEXT NOT NULL CHECK(json_valid(body))
);
CREATE INDEX media_project ON media(project_id);
CREATE TABLE styles (id TEXT PRIMARY KEY NOT NULL,
project_id TEXT NOT NULL REFERENCES projects(id),
revision INTEGER NOT NULL CHECK(revision >= 0),
body TEXT NOT NULL CHECK(json_valid(body)),
logical_id TEXT NOT NULL,
version INTEGER NOT NULL,
UNIQUE(project_id,logical_id,version)
);
CREATE INDEX styles_project ON styles(project_id);
CREATE TABLE assets (id TEXT PRIMARY KEY NOT NULL,
project_id TEXT NOT NULL REFERENCES projects(id),
revision INTEGER NOT NULL CHECK(revision >= 0),
body TEXT NOT NULL CHECK(json_valid(body)),
logical_id TEXT NOT NULL,
version INTEGER NOT NULL,
UNIQUE(project_id,logical_id,version)
);
CREATE INDEX assets_project ON assets(project_id);
CREATE TABLE scenes (id TEXT PRIMARY KEY NOT NULL,
project_id TEXT NOT NULL REFERENCES projects(id),
revision INTEGER NOT NULL CHECK(revision >= 0),
body TEXT NOT NULL CHECK(json_valid(body))
);
CREATE INDEX scenes_project ON scenes(project_id);
CREATE TABLE previews (id TEXT PRIMARY KEY NOT NULL,
project_id TEXT NOT NULL REFERENCES projects(id),
revision INTEGER NOT NULL CHECK(revision >= 0),
body TEXT NOT NULL CHECK(json_valid(body))
);
CREATE INDEX previews_project ON previews(project_id);
CREATE TABLE runs (id TEXT PRIMARY KEY NOT NULL,
project_id TEXT NOT NULL REFERENCES projects(id),
revision INTEGER NOT NULL CHECK(revision >= 0),
body TEXT NOT NULL CHECK(json_valid(body)),
preview_id TEXT NOT NULL REFERENCES previews(id),
idempotency_key TEXT NOT NULL,
UNIQUE(project_id,idempotency_key),
UNIQUE(preview_id)
);
CREATE INDEX runs_project ON runs(project_id);
CREATE TABLE candidates (id TEXT PRIMARY KEY NOT NULL,
project_id TEXT NOT NULL REFERENCES projects(id),
revision INTEGER NOT NULL CHECK(revision >= 0),
body TEXT NOT NULL CHECK(json_valid(body)),
run_id TEXT NOT NULL REFERENCES runs(id),
output_index INTEGER NOT NULL,
UNIQUE(run_id,output_index)
);
CREATE INDEX candidates_project ON candidates(project_id);
CREATE TABLE reviews (id TEXT PRIMARY KEY NOT NULL,
project_id TEXT NOT NULL REFERENCES projects(id),
revision INTEGER NOT NULL CHECK(revision >= 0),
body TEXT NOT NULL CHECK(json_valid(body))
);
CREATE INDEX reviews_project ON reviews(project_id);
CREATE TABLE effects (id TEXT PRIMARY KEY NOT NULL,
project_id TEXT NOT NULL REFERENCES projects(id),
revision INTEGER NOT NULL CHECK(revision >= 0),
body TEXT NOT NULL CHECK(json_valid(body)),
candidate_id TEXT NOT NULL REFERENCES candidates(id),
UNIQUE(candidate_id)
);
CREATE INDEX effects_project ON effects(project_id);
CREATE TABLE exports (id TEXT PRIMARY KEY NOT NULL,
project_id TEXT NOT NULL REFERENCES projects(id),
revision INTEGER NOT NULL CHECK(revision >= 0),
body TEXT NOT NULL CHECK(json_valid(body))
);
CREATE INDEX exports_project ON exports(project_id);
CREATE TABLE experiments (id TEXT PRIMARY KEY NOT NULL,
project_id TEXT NOT NULL REFERENCES projects(id),
revision INTEGER NOT NULL CHECK(revision >= 0),
body TEXT NOT NULL CHECK(json_valid(body))
);
CREATE INDEX experiments_project ON experiments(project_id);
CREATE TABLE worker_lease (id INTEGER PRIMARY KEY CHECK(id=1), owner TEXT NOT NULL, expires_at TEXT NOT NULL);
