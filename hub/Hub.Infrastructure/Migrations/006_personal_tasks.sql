-- Faz 8 (spec §21): notes to self. project_root is plain text (no FK) so a note survives a forgotten project.
CREATE TABLE personal_tasks (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    text         TEXT NOT NULL,
    project_root TEXT,
    due_date     TEXT,
    due_time     TEXT,
    priority     INTEGER NOT NULL DEFAULT 1,
    created_at   INTEGER NOT NULL,
    updated_at   INTEGER NOT NULL,
    completed_at INTEGER,
    reminded_at  INTEGER
);
CREATE INDEX ix_personal_tasks_open ON personal_tasks(completed_at, due_date);
