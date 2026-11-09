-- 0.6: linked git worktree a session works in (its project_root stays the main repository) and that worktree's branch.
ALTER TABLE sessions ADD COLUMN worktree TEXT;
ALTER TABLE sessions ADD COLUMN worktree_branch TEXT;
