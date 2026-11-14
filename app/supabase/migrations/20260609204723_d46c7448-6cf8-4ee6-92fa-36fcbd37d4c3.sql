CREATE TABLE public.realized_pnl (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  platform text,
  ticker text,
  realized_eur numeric NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.realized_pnl TO authenticated;
GRANT ALL ON public.realized_pnl TO service_role;

ALTER TABLE public.realized_pnl ENABLE ROW LEVEL SECURITY;

CREATE POLICY "own realized pnl" ON public.realized_pnl
  FOR ALL TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE INDEX realized_pnl_user_platform_idx ON public.realized_pnl(user_id, platform);