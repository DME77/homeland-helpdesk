-- ═══════════════════════════════════════════════════════════
-- Homeland Helpdesk — Supabase schema (one-time setup)
--
-- HOW TO RUN:
--   1. Open your Supabase project → SQL Editor (left sidebar).
--   2. Click "+ New query".
--   3. Paste this entire file, then press Run (Ctrl/Cmd + Enter).
--   4. You should see "Success. No rows returned." — that's correct.
--   5. Verify: Table Editor → you should now see the table "hg_state"
--      with one row (id = 1, data = {}).
--
-- WHAT THIS DOES:
--   • Creates a single table "hg_state" that holds the entire app state
--     (users, queries, complaints) as one JSON blob.
--   • Inserts an empty starter row — the app fills it on first login.
--   • Disables Row Level Security (RLS) so the anon key can read/write.
--     ⚠ Fine for internal use. For public deployment, add RLS + Supabase Auth later.
--   • Enables Realtime on the table so every device auto-refreshes when
--     data changes (a manager on their laptop sees a query the moment
--     the admin assigns it from their phone).
-- ═══════════════════════════════════════════════════════════

-- 1) The state table
CREATE TABLE IF NOT EXISTS hg_state (
  id      integer     PRIMARY KEY,
  data    jsonb       NOT NULL DEFAULT '{}',
  updated timestamptz          DEFAULT now()
);

-- 2) Seed the single row the app writes to (id = 1)
INSERT INTO hg_state (id, data)
VALUES (1, '{}')
ON CONFLICT (id) DO NOTHING;

-- 3) Allow the anon key to read/write (demo mode — tighten with RLS later).
--    Supabase auto-enables RLS on all new tables, so we forcefully turn it off
--    AND add permissive policies as a fallback (in case a future setting flips it back on).
ALTER TABLE hg_state DISABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "hg_state_all_read"  ON hg_state;
DROP POLICY IF EXISTS "hg_state_all_write" ON hg_state;
CREATE POLICY "hg_state_all_read"  ON hg_state FOR SELECT USING (true);
CREATE POLICY "hg_state_all_write" ON hg_state FOR ALL    USING (true) WITH CHECK (true);

-- 4) Enable live cross-device sync (Realtime broadcasts UPDATEs to all clients).
--    Wrapped in DO/EXCEPTION so re-running the script never fails if it's already added.
DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE hg_state;
EXCEPTION
  WHEN duplicate_object THEN
    RAISE NOTICE 'Table hg_state is already in supabase_realtime — skipping.';
END $$;

-- Done. Now copy your Project URL + anon public key from
-- Settings → API and paste them into index.html near the top of <script>:
--   var HG_SUPABASE_URL = 'https://xxxxxxxxxxxxxxxx.supabase.co';
--   var HG_SUPABASE_KEY = 'eyJhbGciOi...';
