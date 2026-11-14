-- S2B PRE-FLIGHT: SYNTHETIC metadata-only SQLite test schema.
-- Not a D1 migration, deployment, authentication, encrypted store or product DB.
-- All tables in ephemeral test SQLite files; never import real interviews.

CREATE TABLE grants (
  tenant_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  engagement_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  active INTEGER NOT NULL CHECK (active IN (0, 1)),
  assigned INTEGER NOT NULL CHECK (assigned IN (0, 1)),
  append_allowed INTEGER NOT NULL CHECK (append_allowed IN (0, 1)),
  PRIMARY KEY (tenant_id, client_id, engagement_id, session_id, actor_id)
);

CREATE TABLE current_heads (
  tenant_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  engagement_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  snapshot_digest TEXT NOT NULL CHECK (length(snapshot_digest) = 64),
  pack_digest TEXT NOT NULL CHECK (length(pack_digest) = 64),
  PRIMARY KEY (tenant_id, client_id, engagement_id, session_id)
);

CREATE TABLE immutable_revisions (
  tenant_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  engagement_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  parent_revision_id TEXT,
  snapshot_digest TEXT NOT NULL CHECK (length(snapshot_digest) = 64),
  pack_digest TEXT NOT NULL CHECK (length(pack_digest) = 64),
  operation_id TEXT NOT NULL CHECK (length(operation_id) = 64),
  PRIMARY KEY (tenant_id, client_id, engagement_id, session_id, revision_id),
  UNIQUE (tenant_id, client_id, engagement_id, session_id, operation_id)
);

CREATE TABLE durable_receipts_trial (
  tenant_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  engagement_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  operation_id TEXT NOT NULL CHECK (length(operation_id) = 64),
  revision_id TEXT NOT NULL,
  snapshot_digest TEXT NOT NULL CHECK (length(snapshot_digest) = 64),
  committed INTEGER NOT NULL CHECK (committed = 1),
  PRIMARY KEY (tenant_id, client_id, engagement_id, session_id, operation_id)
);
