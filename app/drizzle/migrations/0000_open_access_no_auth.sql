-- Make tables usable without sign-in (single shared dataset)
ALTER TABLE public.positions ALTER COLUMN user_id DROP NOT NULL;
ALTER TABLE public.realized_pnl ALTER COLUMN user_id DROP NOT NULL;
ALTER TABLE public.upload_history ALTER COLUMN user_id DROP NOT NULL;

DO $$
DECLARE p record;
BEGIN
  FOR p IN
    SELECT schemaname, tablename, policyname FROM pg_policies
    WHERE schemaname = 'public' AND tablename IN ('positions','realized_pnl','upload_history')
  LOOP
    EXECUTE format('DROP POLICY %I ON %I.%I', p.policyname, p.schemaname, p.tablename);
  END LOOP;
END $$;

CREATE POLICY "Open access" ON public.positions FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Open access" ON public.realized_pnl FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Open access" ON public.upload_history FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.positions TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.realized_pnl TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.upload_history TO anon, authenticated;
GRANT ALL ON public.positions TO service_role;
GRANT ALL ON public.realized_pnl TO service_role;
GRANT ALL ON public.upload_history TO service_role;