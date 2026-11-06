-- Portable schema: runs on SQLite and PostgreSQL. JSON columns are stored as TEXT.

CREATE TABLE IF NOT EXISTS patients (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  age        INTEGER,
  sex        TEXT,
  allergies  TEXT
);

CREATE TABLE IF NOT EXISTS visits (
  id          TEXT PRIMARY KEY,
  patient_id  TEXT NOT NULL REFERENCES patients(id),
  visit_date  TEXT NOT NULL,
  facility    TEXT,
  type        TEXT,
  prescriber  TEXT,
  doc_title   TEXT,
  doc_lines   TEXT NOT NULL,              -- the source document, line by line (never edited)
  upload_id   TEXT,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS visits_patient ON visits (patient_id, visit_date);

CREATE TABLE IF NOT EXISTS medications (
  visit_id  TEXT NOT NULL REFERENCES visits(id),
  idx       INTEGER NOT NULL,
  data      TEXT NOT NULL,                -- extracted values + line number in the source document
  PRIMARY KEY (visit_id, idx)
);

CREATE TABLE IF NOT EXISTS tickets (
  id                TEXT PRIMARY KEY,
  fingerprint       TEXT NOT NULL UNIQUE,  -- one ticket per discrepancy, however often it is sent
  patient_id        TEXT NOT NULL,
  patient_name      TEXT,
  generic           TEXT,
  type              TEXT NOT NULL,
  title             TEXT NOT NULL,
  sources           TEXT NOT NULL,
  decisions         TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'open',   -- open | clarification | resolved
  claimed_by_id     TEXT,
  claimed_by        TEXT,
  claim_expires_at  BIGINT NOT NULL DEFAULT 0,
  version           INTEGER NOT NULL DEFAULT 1,     -- optimistic concurrency (If-Match)
  created_at        TEXT NOT NULL,
  history           TEXT NOT NULL,
  resolution        TEXT
);
CREATE INDEX IF NOT EXISTS tickets_status ON tickets (status, created_at);

CREATE TABLE IF NOT EXISTS idempotency_keys (
  key           TEXT PRIMARY KEY,         -- second insert of the same key fails -> replay
  user_id       TEXT NOT NULL,
  request_hash  TEXT NOT NULL,
  status_code   INTEGER NOT NULL,
  response      TEXT NOT NULL,
  created_at    BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
  seq        INTEGER PRIMARY KEY,         -- gap-free, a fork is impossible
  at         TEXT NOT NULL,
  actor      TEXT NOT NULL,
  role       TEXT NOT NULL,
  action     TEXT NOT NULL,
  target     TEXT,
  detail     TEXT,
  prev_hash  TEXT NOT NULL,
  hash       TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS uploads (
  id             TEXT PRIMARY KEY,
  patient_id     TEXT NOT NULL,
  file_name      TEXT,
  size           BIGINT,
  sha256         TEXT NOT NULL,
  content_type   TEXT,
  doc_type       TEXT,
  facility       TEXT,
  visit_date     TEXT,
  uploaded_by    TEXT,
  status         TEXT NOT NULL,           -- awaiting_file | queued | processing | extracted | failed
  file_received  INTEGER NOT NULL DEFAULT 0,
  storage_path   TEXT,
  queued_at      BIGINT,
  started_at     BIGINT,
  attempts       INTEGER NOT NULL DEFAULT 0,
  extracted      TEXT,
  error          TEXT,
  visit_id       TEXT,
  created_at     TEXT NOT NULL,
  UNIQUE (patient_id, sha256)             -- same file for the same patient = one document
);
CREATE INDEX IF NOT EXISTS uploads_queue ON uploads (status, queued_at);

CREATE TABLE IF NOT EXISTS handovers (
  code        TEXT PRIMARY KEY,
  patient_id  TEXT NOT NULL,
  created_by  TEXT,
  created_at  TEXT,
  expires_at  BIGINT NOT NULL,
  scope       TEXT,
  uses        INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS counters (
  name   TEXT PRIMARY KEY,
  value  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS demo_settings (
  name   TEXT PRIMARY KEY,
  value  TEXT NOT NULL
)
