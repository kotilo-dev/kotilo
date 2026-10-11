-- Faz 6 (spec §18).

-- §18.2 customer labels for the cost report.
CREATE TABLE customers (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    name     TEXT NOT NULL,
    color    TEXT NOT NULL,
    archived INTEGER NOT NULL DEFAULT 0
);
ALTER TABLE projects ADD COLUMN customer_id INTEGER REFERENCES customers(id) ON DELETE SET NULL;

-- §18.3 last git check per project root.
CREATE TABLE git_status (
    project_root        TEXT PRIMARY KEY,
    branch              TEXT,
    detached            INTEGER NOT NULL DEFAULT 0,
    has_upstream        INTEGER NOT NULL DEFAULT 0,
    ahead               INTEGER NOT NULL DEFAULT 0,
    behind              INTEGER NOT NULL DEFAULT 0,
    changed             INTEGER NOT NULL DEFAULT 0,
    last_commit_at      INTEGER,
    last_commit_subject TEXT,
    checked_at          INTEGER NOT NULL
);

-- §18.7 todo item states; a row only when an item's state changes.
CREATE TABLE todo_snapshots (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    project_root TEXT NOT NULL,
    file         TEXT NOT NULL,
    item_hash    TEXT NOT NULL,
    text         TEXT NOT NULL,
    state        TEXT NOT NULL,
    seen_at      INTEGER NOT NULL
);
CREATE INDEX ix_todo_snapshots_item ON todo_snapshots(project_root, file, item_hash, seen_at);
CREATE INDEX ix_todo_snapshots_seen ON todo_snapshots(seen_at);

-- §18.7 generated daily summaries.
CREATE TABLE daily_summaries (
    date         TEXT PRIMARY KEY,
    markdown     TEXT NOT NULL,
    model        TEXT,
    generated_at INTEGER NOT NULL,
    source_hash  TEXT NOT NULL
);

-- §18.4 / §18.5 session error and context reset survive a restart.
ALTER TABLE sessions ADD COLUMN error_kind TEXT;
ALTER TABLE sessions ADD COLUMN error_resets_at INTEGER;
ALTER TABLE sessions ADD COLUMN context_reset_at INTEGER;
