-- ============================================================================
-- Bench seed — a realistic warehouse, and a second one to isolate the lock
--
-- Two orgs with identical shape. The whole point of the concurrent-write
-- measurement is the DIFFERENCE between writers sharing an org and writers in
-- separate orgs: same work, same indexes, same triggers, one shared row. If
-- both configurations run at the same speed there is no contention to fix; if
-- the same-org case is slower, the gap IS the org_sync_watermark row lock.
--
-- Seeded as postgres with RLS off, the same way the pgTAP fixtures do it. The
-- measured path itself runs as papa_app with RLS on, because measuring the
-- write path with tenancy disabled would measure a system we do not ship.
-- ============================================================================
set role postgres;

alter table orgs        disable row level security;
alter table users       disable row level security;
alter table memberships disable row level security;
alter table locations   disable row level security;
alter table products    disable row level security;
alter table assets      disable row level security;
alter table asset_tags  disable row level security;
alter table jobs        disable row level security;
alter table devices     disable row level security;

insert into orgs (id, name, slug) values
  ('11111111-1111-7111-8111-111111111111', 'Lumos Rentals',  'lumos'),
  ('22222222-2222-7222-8222-222222222222', 'Kamran Cine',    'kamran')
on conflict do nothing;

-- Eight techs per org. Real warehouses do not have eight people scanning at
-- once; that is the point — the test should push well past the real ceiling.
insert into users (id, display_name)
select ('aaaaaaaa-aaaa-7aaa-8aaa-' || lpad(g::text, 12, '0'))::uuid, 'Tech ' || g
  from generate_series(1, 8) g
on conflict do nothing;

insert into memberships (org_id, user_id, role)
select o.id, ('aaaaaaaa-aaaa-7aaa-8aaa-' || lpad(g::text, 12, '0'))::uuid, 'warehouse'
  from generate_series(1, 8) g,
       (values ('11111111-1111-7111-8111-111111111111'::uuid),
               ('22222222-2222-7222-8222-222222222222'::uuid)) o(id)
on conflict do nothing;

insert into locations (id, org_id, name, kind) values
  ('10000000-0000-7000-8000-000000000001', '11111111-1111-7111-8111-111111111111', 'Rack A', 'rack'),
  ('10000000-0000-7000-8000-000000000002', '22222222-2222-7222-8222-222222222222', 'Rack A', 'rack')
on conflict do nothing;

insert into products (id, org_id, category, display_name) values
  ('20000000-0000-7000-8000-000000000001', '11111111-1111-7111-8111-111111111111', 'camera', 'Sony FX9'),
  ('20000000-0000-7000-8000-000000000002', '22222222-2222-7222-8222-222222222222', 'camera', 'Sony FX9')
on conflict do nothing;

insert into jobs (id, org_id, label, status) values
  ('30000000-0000-7000-8000-000000000001', '11111111-1111-7111-8111-111111111111', 'Rafi Peer shoot', 'open'),
  ('30000000-0000-7000-8000-000000000002', '22222222-2222-7222-8222-222222222222', 'Rafi Peer shoot', 'open')
on conflict do nothing;

-- 20,000 assets per org. Large enough that index quality still matters at the
-- point of contention, so a contention finding cannot be confused with a scan.
insert into assets (id, org_id, product_id, asset_code, presence)
select ('40000000-0000-7000-8000-' || lpad((g + 100000 * o.n)::text, 12, '0'))::uuid,
       o.id, o.pid, 'A' || o.n || '-' || g, 'here'
  from generate_series(1, 20000) g,
       (values ('11111111-1111-7111-8111-111111111111'::uuid, '20000000-0000-7000-8000-000000000001'::uuid, 1),
               ('22222222-2222-7222-8222-222222222222'::uuid, '20000000-0000-7000-8000-000000000002'::uuid, 2)) o(id, pid, n)
on conflict do nothing;

alter table orgs        enable row level security;
alter table users       enable row level security;
alter table memberships enable row level security;
alter table locations   enable row level security;
alter table products    enable row level security;
alter table assets      enable row level security;
alter table asset_tags  enable row level security;
alter table jobs        enable row level security;
alter table devices     enable row level security;

analyze;
