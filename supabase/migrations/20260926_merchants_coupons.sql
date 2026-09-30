-- Run in the Supabase SQL Editor before enabling the new features.
create table if not exists public.merchants (
  email text primary key check (email = lower(trim(email))),
  added_at timestamptz not null default now()
);

create table if not exists public.coupons (
  code text primary key check (code = upper(trim(code))),
  discount_percent numeric not null check (discount_percent > 0 and discount_percent <= 100),
  active boolean not null default true,
  expires_at timestamptz
);

alter table public.merchants enable row level security;
alter table public.coupons enable row level security;
-- No public policies: server-side access requires SUPABASE_SERVICE_ROLE_KEY.
revoke all on public.merchants from anon, authenticated;
revoke all on public.coupons from anon, authenticated;
