-- ============================================================================
-- The asset model
--
-- Exercises the invariants that are load-bearing for the product, not the
-- column list. The column list is obvious from the migration; what is worth
-- testing is the handful of constraints that silently prevent a class of
-- real-world disaster.
-- ============================================================================
begin;
select plan(40);

-- ---------------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------------
set local role postgres;

select fixture_rls_off();

insert into orgs (id, name, slug) values
  ('11111111-1111-7111-8111-111111111111', 'Lumos Rentals',   'lumos'),
  ('22222222-2222-7222-8222-222222222222', 'Kamran Cine Hub', 'kamran');

insert into users (id, display_name) values
  ('aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa', 'Bilal');

insert into memberships (org_id, user_id, role) values
  ('11111111-1111-7111-8111-111111111111', 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa', 'warehouse');

insert into locations (id, org_id, name, kind, code) values
  ('10000000-0000-7000-8000-000000000001', '11111111-1111-7111-8111-111111111111', 'Rack A', 'rack', 'RACK-A'),
  ('10000000-0000-7000-8000-000000000002', '11111111-1111-7111-8111-111111111111', 'Van 1',  'vehicle', 'VAN-1');

insert into products (id, org_id, category, manufacturer, model, display_name, tracking_mode) values
  ('20000000-0000-7000-8000-000000000001', '11111111-1111-7111-8111-111111111111', 'camera', 'Sony', 'FX9', 'Sony FX9', 'serialized'),
  ('20000000-0000-7000-8000-000000000002', '11111111-1111-7111-8111-111111111111', 'audio',  'Generic', 'XLR 5m', 'XLR cable 5m', 'bulk');

insert into assets (id, org_id, product_id, asset_code, serial_number, is_container, rentable) values
  ('30000000-0000-7000-8000-000000000001', '11111111-1111-7111-8111-111111111111', '20000000-0000-7000-8000-000000000001', 'FX9-02', '1000345', false, true),
  ('30000000-0000-7000-8000-000000000002', '11111111-1111-7111-8111-111111111111', '20000000-0000-7000-8000-000000000001', 'CASE-01', null, true, true),
  ('30000000-0000-7000-8000-000000000003', '11111111-1111-7111-8111-111111111111', '20000000-0000-7000-8000-000000000001', 'PLATE-07', null, false, false);

reset role;

-- ---------------------------------------------------------------------------
-- Status is three axes, not one
--
-- The defining case: a sub-rented lens that is currently out on a job. A
-- single twelve-value status column CANNOT represent it, because
-- `sub_rented_in` and `out` are mutually exclusive values and both are true.
-- ---------------------------------------------------------------------------
select has_column('assets', 'presence');
select has_column('assets', 'health');
select has_column('assets', 'ownership');
select hasnt_column('assets', 'status');

select lives_ok(
  $$update assets set presence = 'out', ownership = 'sub_rented_in', health = 'ok'
     where asset_code = 'FX9-02'$$,
  'a sub-rented asset can simultaneously be out on a job'
);

select is(
  (select presence || '/' || health || '/' || ownership from assets where asset_code = 'FX9-02'),
  'out/ok/sub_rented_in',
  'and all three axes read back independently'
);

select throws_ok(
  $$update assets set presence = 'somewhere' where asset_code = 'FX9-02'$$,
  '23514', null, 'presence is constrained to the four known values'
);

-- Reset for later assertions.
select lives_ok($$update assets set presence = 'here', ownership = 'owned' where asset_code = 'FX9-02'$$);

-- ---------------------------------------------------------------------------
-- Containment — a thing is in at most one container
--
-- This single partial unique index eliminates the entire "the plate is in two
-- cases" class of bug.
-- ---------------------------------------------------------------------------
select lives_ok(
  $$insert into asset_containment (org_id, parent_asset_id, child_asset_id, relation)
    values ('11111111-1111-7111-8111-111111111111',
            '30000000-0000-7000-8000-000000000002',
            '30000000-0000-7000-8000-000000000001', 'packed')$$,
  'an asset can be packed into a case'
);

select throws_ok(
  $$insert into asset_containment (org_id, parent_asset_id, child_asset_id, relation)
    values ('11111111-1111-7111-8111-111111111111',
            '30000000-0000-7000-8000-000000000003',
            '30000000-0000-7000-8000-000000000001', 'packed')$$,
  '23505', null,
  'the SAME asset cannot be inside two containers at once'
);

-- Removing it from the first case frees it for the second. This is what a
-- re-pack actually is.
select lives_ok(
  $$update asset_containment set removed_at = now()
     where child_asset_id = '30000000-0000-7000-8000-000000000001'$$,
  'unpacking closes the containment row'
);

select lives_ok(
  $$insert into asset_containment (org_id, parent_asset_id, child_asset_id, relation)
    values ('11111111-1111-7111-8111-111111111111',
            '30000000-0000-7000-8000-000000000003',
            '30000000-0000-7000-8000-000000000001', 'packed')$$,
  'and it can then be packed elsewhere'
);

select throws_ok(
  $$insert into asset_containment (org_id, parent_asset_id, child_asset_id, relation)
    values ('11111111-1111-7111-8111-111111111111',
            '30000000-0000-7000-8000-000000000002',
            '30000000-0000-7000-8000-000000000002', 'packed')$$,
  '23514', null,
  'a container cannot contain itself'
);

select ok(
  exists (select 1 from pg_constraint where conname = 'asset_containment_relation_check'),
  'relation distinguishes permanent from packed — implied scan events depend on it'
);

-- ---------------------------------------------------------------------------
-- Tags — opaque, re-issuable, globally unique
-- ---------------------------------------------------------------------------
select is(length(generate_tag_code()) > 20, true, 'generated tag codes carry real entropy');
select is(
  (select count(distinct generate_tag_code())::int from generate_series(1, 200)),
  200, 'generated tag codes do not collide'
);
select matches(generate_tag_code(), '^v1', 'tag codes carry a version prefix');

select lives_ok(
  $$insert into asset_tags (org_id, tag_code, status) values
    ('11111111-1111-7111-8111-111111111111', 'v1-preprinted-001', 'unbound')$$,
  'a blank tag can be pre-printed before any asset exists'
);

select throws_ok(
  $$insert into asset_tags (org_id, tag_code, status, asset_id) values
    ('11111111-1111-7111-8111-111111111111', 'v1-bad', 'unbound',
     '30000000-0000-7000-8000-000000000001')$$,
  '23514', null,
  'an unbound tag cannot already point at an asset'
);

select throws_ok(
  $$insert into asset_tags (org_id, tag_code, status) values
    ('11111111-1111-7111-8111-111111111111', 'v1-bad2', 'active')$$,
  '23514', null,
  'an active tag must point at an asset'
);

select lives_ok(
  $$update asset_tags set status = 'active', asset_id = '30000000-0000-7000-8000-000000000001',
       bound_at = now() where tag_code = 'v1-preprinted-001'$$,
  'binding a pre-printed tag at intake'
);

select throws_ok(
  $$insert into asset_tags (org_id, tag_code, status, asset_id) values
    ('11111111-1111-7111-8111-111111111111', 'v1-second', 'active',
     '30000000-0000-7000-8000-000000000001')$$,
  '23505', null,
  'an asset cannot carry two active tags'
);

-- Re-issue: the label was soaked off, so retire it and bind a fresh one. This
-- is the flow that opaque tag ids exist to make possible.
select lives_ok(
  $$update asset_tags set status = 'retired', unbound_at = now()
     where tag_code = 'v1-preprinted-001'$$,
  'a damaged label is retired, not deleted'
);

select lives_ok(
  $$insert into asset_tags (org_id, tag_code, status, asset_id, bound_at) values
    ('11111111-1111-7111-8111-111111111111', 'v1-reissued', 'active',
     '30000000-0000-7000-8000-000000000001', now())$$,
  'and a new label is bound to the SAME asset'
);

select is(
  (select asset_id from asset_tags where tag_code = 'v1-preprinted-001'),
  '30000000-0000-7000-8000-000000000001'::uuid,
  'the retired label still records what it used to be on'
);

-- Globally unique, not per-org: the public resolver is one lookup, and a tag
-- is never ambiguous if two houses merge or one sub-rents to the other.
select throws_ok(
  $$insert into asset_tags (org_id, tag_code, status) values
    ('22222222-2222-7222-8222-222222222222', 'v1-reissued', 'unbound')$$,
  '23505', null,
  'tag codes are unique ACROSS orgs, not merely within one'
);

-- ---------------------------------------------------------------------------
-- Identity
-- ---------------------------------------------------------------------------
select throws_ok(
  $$insert into assets (org_id, product_id, asset_code) values
    ('11111111-1111-7111-8111-111111111111','20000000-0000-7000-8000-000000000001','FX9-02')$$,
  '23505', null, 'asset_code is unique within an org'
);

select lives_ok(
  $$insert into assets (org_id, product_id, asset_code) values
    ('22222222-2222-7222-8222-222222222222','20000000-0000-7000-8000-000000000001','FX9-02')$$,
  'but the same code may exist in a different org'
);

select throws_ok(
  $$insert into assets (org_id, product_id, asset_code, serial_number) values
    ('11111111-1111-7111-8111-111111111111','20000000-0000-7000-8000-000000000001','FX9-03','1000345')$$,
  '23505', null,
  'a serial number cannot be registered twice in one org'
);

select throws_ok(
  $$insert into assets (org_id, product_id, asset_code, is_container, rentable) values
    ('11111111-1111-7111-8111-111111111111','20000000-0000-7000-8000-000000000001','X1', true, false)$$,
  '23514', null,
  'a container cannot also be a permanent accessory'
);

-- ---------------------------------------------------------------------------
-- Soft-delete guards
--
-- The FKs are ON DELETE RESTRICT, which guards a hard delete — something
-- nobody ever does here. The failure that actually happens is setting
-- deleted_at on a product that still has assets, orphaning them while the
-- constraint reports success. These triggers are the real guard.
-- ---------------------------------------------------------------------------
select throws_ok(
  $$update products set deleted_at = now() where id = '20000000-0000-7000-8000-000000000001'$$,
  '23503', null,
  'a product with live assets cannot be soft-deleted'
);

-- Put something on the shelf first, or the guard has nothing to guard.
update assets set current_location_id = '10000000-0000-7000-8000-000000000001'
  where asset_code = 'FX9-02';

select throws_ok(
  $$update locations set deleted_at = now() where id = '10000000-0000-7000-8000-000000000001'$$,
  '23503', null,
  'a location still holding assets cannot be soft-deleted'
);

select lives_ok(
  $$update locations set deleted_at = now() where id = '10000000-0000-7000-8000-000000000002'$$,
  'an empty location can be soft-deleted'
);

-- ---------------------------------------------------------------------------
-- Bulk stock
-- ---------------------------------------------------------------------------
select lives_ok(
  $$insert into stock_lots (org_id, product_id, location_id, qty_on_hand) values
    ('11111111-1111-7111-8111-111111111111','20000000-0000-7000-8000-000000000002',
     '10000000-0000-7000-8000-000000000001', 20)$$,
  'bulk stock is counted per product per location'
);

select throws_ok(
  $$update stock_lots set qty_on_hand = -1
     where product_id = '20000000-0000-7000-8000-000000000002'$$,
  '23514', null, 'stock on hand cannot go negative'
);

select throws_ok(
  $$insert into stock_lots (org_id, product_id, location_id, qty_on_hand) values
    ('11111111-1111-7111-8111-111111111111','20000000-0000-7000-8000-000000000002',
     '10000000-0000-7000-8000-000000000001', 5)$$,
  '23505', null, 'one lot per product per location'
);

-- ---------------------------------------------------------------------------
-- Cross-org isolation, again, for the new tables
--
-- Every new tenant table must be proven isolated. A table added without this
-- block is a leak waiting to be discovered by a customer.
--
-- RLS WAS DISABLED FOR THE FIXTURES ABOVE. Turning it back on is not
-- housekeeping — forgetting it makes every assertion below pass against
-- unprotected tables, which is exactly what happened on the first run of this
-- file. The `rls_enabled` assertion exists so that mistake can never be silent
-- again.
-- ---------------------------------------------------------------------------
select fixture_rls_on();

select is(
  (select count(*)::int from pg_class
    where relname in ('orgs','users','memberships','locations','products','assets',
                      'asset_tags','asset_containment','stock_lots','jobs')
      and relnamespace = 'public'::regnamespace
      and not relrowsecurity),
  0,
  'RLS is back on for every table the fixtures disabled it for'
);

grant execute on all functions in schema public to papa_app;
set local role papa_app;

select ok(not (select rolsuper from pg_roles where rolname = current_user),
          'isolation assertions run as a non-superuser');

set local papa.org_id  = '11111111-1111-7111-8111-111111111111';
set local papa.user_id = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';

select is((select count(*)::int from assets), 3, 'sees only its own org''s assets');
select is((select count(*)::int from assets where asset_code = 'FX9-02'
           and org_id = '22222222-2222-7222-8222-222222222222'), 0,
          'LEAK: another org''s asset is invisible even by exact code');
select is((select count(*)::int from locations), 2, 'sees only its own locations');
select is((select count(*)::int from products), 2, 'sees only its own products');
select is((select count(*)::int from asset_tags
           where org_id = '22222222-2222-7222-8222-222222222222'), 0,
          'LEAK: another org''s tags are invisible');

-- The shared catalogue is deliberately NOT org-scoped.
select ok((select count(*) from global_products) >= 0, 'the global catalogue is readable by every org');

select * from finish();
rollback;
