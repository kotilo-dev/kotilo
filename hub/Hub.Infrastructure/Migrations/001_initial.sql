-- Spec §13. Timestamps are Unix epoch milliseconds (UTC).

CREATE TABLE sessions (
    session_id       TEXT PRIMARY KEY,
    project_root     TEXT NOT NULL,
    transcript_path  TEXT,
    state            TEXT NOT NULL,
    state_since      INTEGER NOT NULL,
    last_event_at    INTEGER NOT NULL,
    current_tool     TEXT,
    last_notification TEXT,
    model            TEXT,
    parent_pid       INTEGER,
    turn_started_at  INTEGER,
    last_completed_at INTEGER,
    ended_at         INTEGER,
    end_reason       TEXT
);
CREATE INDEX ix_sessions_state ON sessions(state);

CREATE TABLE session_transitions (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id  TEXT NOT NULL,
    from_state  TEXT NOT NULL,
    to_state    TEXT NOT NULL,
    at          INTEGER NOT NULL,
    detail      TEXT
);
CREATE INDEX ix_transitions_session_at ON session_transitions(session_id, at);
CREATE INDEX ix_transitions_at ON session_transitions(at);

CREATE TABLE usage_entries (
    dedup_key     TEXT NOT NULL UNIQUE,
    session_id    TEXT,
    project_root  TEXT,
    model         TEXT,
    ts            INTEGER NOT NULL,
    input         INTEGER NOT NULL,
    output        INTEGER NOT NULL,
    cache_create  INTEGER NOT NULL,
    cache_read    INTEGER NOT NULL,
    cost_usd      REAL
);
CREATE INDEX ix_usage_ts ON usage_entries(ts);

CREATE TABLE transcript_offsets (
    path            TEXT PRIMARY KEY,
    offset          INTEGER NOT NULL,
    last_write_utc  INTEGER NOT NULL
);

CREATE TABLE projects (
    root          TEXT PRIMARY KEY,
    alias         TEXT,
    hidden        INTEGER NOT NULL DEFAULT 0,
    discovered_at INTEGER NOT NULL
);

CREATE TABLE notification_log (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    rule_id   TEXT NOT NULL,
    key       TEXT NOT NULL,
    fired_at  INTEGER NOT NULL
);
CREATE INDEX ix_notification_log_rule_key ON notification_log(rule_id, key, fired_at);
