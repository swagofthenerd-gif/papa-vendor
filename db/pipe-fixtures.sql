-- ============================================================================
-- The pipe's fixtures (W9) — NOT a migration, NOT the pgTAP fixtures.
--
-- Applied by db/pipe-up.sh after the migrations, to the throwaway database
-- the local proof talks to through PostgREST. One rental house, four people,
-- two phones' worth of enrolable members, a customer, a small fleet with
-- labels, and one open job. The proof (apps/app/test/pipe) enrols the
-- phones itself — device rows and sessions are minted the real way.
--
-- Also the gateway's login role: PostgREST connects as papa_authenticator
-- and SWITCHES to papa_app for every request (db-anon-role). papa_app
-- stays NOLOGIN; the authenticator can do nothing but become it.
-- ============================================================================

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'papa_authenticator') then
    create role papa_authenticator login password 'papa' noinherit nosuperuser nobypassrls;
  end if;
end
$$;
grant papa_app to papa_authenticator;

-- pgTAP's helpers are not installed here; toggle RLS by hand for the seed.
alter table orgs disable row level security;
alter table users disable row level security;
alter table memberships disable row level security;
alter table customers disable row level security;
alter table products disable row level security;
alter table assets disable row level security;
alter table asset_tags disable row level security;
alter table locations disable row level security;
alter table jobs disable row level security;

insert into orgs (id, name, slug, settings) values
  ('11111111-1111-7111-8111-111111111111', 'Lumos Rentals', 'lumos',
   '{"new_customer_value_threshold_minor": 100000000000}'::jsonb);

insert into users (id, display_name, phone) values
  ('aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa', 'Bilal',  '+923000000002'),
  ('bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb', 'Imran',  '+923000000001'),
  ('cccccccc-cccc-7ccc-8ccc-cccccccccccc', 'Kashif', '+923000000003'),
  ('dddddddd-dddd-7ddd-8ddd-dddddddddddd', 'Danish', '+923000000007');

insert into memberships (org_id, user_id, role, status, pin_hash, pin_set_at) values
  ('11111111-1111-7111-8111-111111111111', 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa', 'desk', 'active',
   crypt('4321', gen_salt('bf')), now()),
  ('11111111-1111-7111-8111-111111111111', 'bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb', 'owner', 'active',
   crypt('1111', gen_salt('bf')), now()),
  ('11111111-1111-7111-8111-111111111111', 'cccccccc-cccc-7ccc-8ccc-cccccccccccc', 'driver', 'active', null, null),
  ('11111111-1111-7111-8111-111111111111', 'dddddddd-dddd-7ddd-8ddd-dddddddddddd', 'warehouse', 'active', null, null);

insert into customers (id, org_id, name) values
  ('50000000-0000-7000-8000-000000000001', '11111111-1111-7111-8111-111111111111', 'Zindagi Films');

insert into locations (id, org_id, name, kind, path, code) values
  ('40000000-0000-7000-8000-000000000001', '11111111-1111-7111-8111-111111111111', 'Rack A', 'rack', 'Warehouse / Rack A', 'RA');

insert into products (id, org_id, category, display_name, tracking_mode) values
  ('20000000-0000-7000-8000-000000000001', '11111111-1111-7111-8111-111111111111', 'camera', 'Sony FX9', 'serialized'),
  ('20000000-0000-7000-8000-000000000002', '11111111-1111-7111-8111-111111111111', 'lens',   'Canon 24-70 f2.8', 'serialized');

insert into assets (id, org_id, product_id, asset_code, current_location_id) values
  ('30000000-0000-7000-8000-000000000001', '11111111-1111-7111-8111-111111111111',
   '20000000-0000-7000-8000-000000000001', 'FX9-01', '40000000-0000-7000-8000-000000000001'),
  ('30000000-0000-7000-8000-000000000002', '11111111-1111-7111-8111-111111111111',
   '20000000-0000-7000-8000-000000000001', 'FX9-02', '40000000-0000-7000-8000-000000000001'),
  ('30000000-0000-7000-8000-000000000003', '11111111-1111-7111-8111-111111111111',
   '20000000-0000-7000-8000-000000000002', 'LNS-01', '40000000-0000-7000-8000-000000000001');

insert into asset_tags (org_id, tag_code, asset_id, status, bound_at) values
  ('11111111-1111-7111-8111-111111111111', 'v1PIPEFX9010000000000001', '30000000-0000-7000-8000-000000000001', 'active', now()),
  ('11111111-1111-7111-8111-111111111111', 'v1PIPEFX9020000000000002', '30000000-0000-7000-8000-000000000002', 'active', now()),
  ('11111111-1111-7111-8111-111111111111', 'v1PIPELNS010000000000003', '30000000-0000-7000-8000-000000000003', 'active', now());

insert into jobs (id, org_id, label, expected_back, status, created_by) values
  ('60000000-0000-7000-8000-000000000001', '11111111-1111-7111-8111-111111111111',
   'Zindagi promo', current_date + 2, 'open', 'bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb');

alter table orgs enable row level security;
alter table users enable row level security;
alter table memberships enable row level security;
alter table customers enable row level security;
alter table products enable row level security;
alter table assets enable row level security;
alter table asset_tags enable row level security;
alter table locations enable row level security;
alter table jobs enable row level security;
