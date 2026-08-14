-- ============================================================================
-- bench_submit — one batch of scans, exactly as a device would send it
--
-- Wraps submit_scan_batch rather than replacing it. The measurement has to run
-- through the real RPC, or it measures a system we do not ship: the row-level
-- projection trigger, the per-statement watermark upsert and the RLS policies
-- are the entire subject of the test.
--
-- SECURITY INVOKER (the default) is load-bearing here. A DEFINER wrapper would
-- run as the superuser owner and bypass RLS, quietly removing the policies
-- from the measured path and flattering the numbers.
--
-- Each writer gets a DISJOINT asset range. Two techs fighting over the same
-- asset row is a different phenomenon from two techs fighting over the org's
-- watermark row, and mixing them would make the result unattributable.
-- ============================================================================
create or replace function bench_submit(
  p_writer     int,
  p_batch      int,
  p_batch_size int,
  p_org_n      int,
  p_job_id     uuid
)
returns int
language plpgsql
as $$
declare
  v_ops jsonb;
  v_n   int := 0;
begin
  select jsonb_agg(
           jsonb_build_object(
             'client_seq',  (p_batch::bigint * p_batch_size + j),
             'asset_id',    ('40000000-0000-7000-8000-' ||
                             lpad((((p_writer - 1) * 2500)
                                   + ((p_batch * p_batch_size + j - 1) % 2500) + 1
                                   + 100000 * p_org_n)::text, 12, '0'))::uuid,
             'event_type',  case when (p_batch % 2) = 0 then 'check_out' else 'check_in' end,
             'entry_method','scanned',
             'job_id',      p_job_id::text,
             'device_time', to_char(clock_timestamp() at time zone 'utc',
                                    'YYYY-MM-DD"T"HH24:MI:SS.MSOF:00')
           ) order by j)
    into v_ops
    from generate_series(1, p_batch_size) j;

  select count(*) into v_n
    from submit_scan_batch('dev-' || p_org_n || '-' || p_writer, v_ops);

  return v_n;
end
$$;

grant execute on function bench_submit(int, int, int, int, uuid) to papa_app;
