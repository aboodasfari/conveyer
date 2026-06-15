-- Persist the reviewer's verdict and reason on the review phase so the
-- UI can show what happened (approve vs request_changes) when the
-- review is waiting for the user's decision, and re-order the action
-- buttons to match. Other phases leave these NULL.
ALTER TABLE phases ADD COLUMN review_verdict TEXT;
ALTER TABLE phases ADD COLUMN review_reason TEXT;
