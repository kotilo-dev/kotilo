-- Faz 2: cache write TTL split (priced differently), sidechain / fast flags for dedup and pricing (D-010).
ALTER TABLE usage_entries ADD COLUMN cache_create_1h INTEGER NOT NULL DEFAULT 0;
ALTER TABLE usage_entries ADD COLUMN sidechain INTEGER NOT NULL DEFAULT 0;
ALTER TABLE usage_entries ADD COLUMN fast INTEGER NOT NULL DEFAULT 0;
CREATE INDEX ix_usage_session ON usage_entries(session_id);
CREATE INDEX ix_notification_log_fired ON notification_log(fired_at);
