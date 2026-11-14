-- Existing rejected: notices cannot be safely associated by queue time or key alone.
-- NULL is intentional: the new sender records a known non-send for unbound warnings.
ALTER TABLE notices ADD COLUMN source_event_key TEXT;
