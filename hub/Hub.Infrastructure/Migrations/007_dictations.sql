-- Faz 9 (spec §22.5): dictation history. The audio itself is never stored.
CREATE TABLE dictations (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at  INTEGER NOT NULL,
    duration_ms INTEGER NOT NULL,
    raw_text    TEXT NOT NULL,
    final_text  TEXT NOT NULL,
    cleaned     INTEGER NOT NULL DEFAULT 0,
    mode        TEXT,
    model       TEXT,
    language    TEXT,
    outputs     TEXT
);
CREATE INDEX ix_dictations_created ON dictations(created_at);
