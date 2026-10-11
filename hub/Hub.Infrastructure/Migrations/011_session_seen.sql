-- 0.3: when the user last looked at a session's finished work ("unseen" = a turn finished after this).
-- Existing sessions count as seen, so an upgrade does not flag every old finished turn.
ALTER TABLE sessions ADD COLUMN seen_at INTEGER;
UPDATE sessions SET seen_at = last_completed_at;
