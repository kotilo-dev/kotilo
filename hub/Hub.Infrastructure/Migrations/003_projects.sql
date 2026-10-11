-- Faz 3: folders added by hand stay listed regardless of activity (spec §8.1).
ALTER TABLE projects ADD COLUMN manual INTEGER NOT NULL DEFAULT 0;
CREATE INDEX ix_usage_project_ts ON usage_entries(project_root, ts);
