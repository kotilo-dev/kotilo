-- M7: the assistant keeps no chat history (no titles, no list): the unused Bip chat list goes.
DROP INDEX IF EXISTS ix_buddy_chats_updated;
DROP TABLE IF EXISTS buddy_chats;
