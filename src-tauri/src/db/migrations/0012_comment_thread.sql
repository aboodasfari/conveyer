-- Thread of messages for a review comment, as a JSON array of
-- {role:'user'|'agent', content}. The original comment is the first
-- user entry; agent replies and user follow-ups append in order so the
-- UI can render each as its own bubble. `body` is kept as a first-line
-- preview for the collapsed card.
ALTER TABLE comments ADD COLUMN thread_json TEXT;
