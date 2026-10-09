-- 177: Event Head — festival-suggestion Location.
-- The Monthly Planner festival grid gained a Location column next to the AI
-- Suggestion cell. Like the Beneficiary dropdown, the chosen spot is written
-- onto every stored suggestion of that festival (NGO + month + date + festival),
-- so the grid, the Excel/PDF export and the Calendar report all show the same
-- place. The value is free text (an NGO's known locations from the client list,
-- or anything typed under "Other…"), so no closed-vocabulary backfill is
-- needed and an empty choice stores NULL.
-- Idempotent: safe to re-run. Restart the backend afterwards: the column probe
-- is cached for the life of the process.

ALTER TABLE event_head_festival_suggestions
  ADD COLUMN IF NOT EXISTS location TEXT;