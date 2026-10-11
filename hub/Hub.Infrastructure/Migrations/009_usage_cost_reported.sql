-- M3: usage reported through the Agent Integration Protocol may carry the agent's own cost; repricing keeps it.
ALTER TABLE usage_entries ADD COLUMN cost_reported INTEGER NOT NULL DEFAULT 0;
