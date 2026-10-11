-- Faz 5: Bip chat list metadata only (spec §17.3). Message content stays in Claude Code's own transcripts.
CREATE TABLE buddy_chats (
    claude_session_id TEXT PRIMARY KEY,
    title             TEXT NOT NULL,
    model             TEXT,
    pinned            INTEGER NOT NULL DEFAULT 0,
    updated_at        INTEGER NOT NULL
);
CREATE INDEX ix_buddy_chats_updated ON buddy_chats(pinned DESC, updated_at DESC);
