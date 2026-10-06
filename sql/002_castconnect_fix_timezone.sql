-- =====================================================================
-- CastConnect fix: trips dated "today" were rejected in the evening
--
-- The problem: the database runs on UTC. After about 8pm Eastern time,
-- UTC has already rolled over to tomorrow, so a rule that said
-- "trip_date >= current_date" rejected a trip the host had quite
-- reasonably dated today. That is what produced:
--
--     new row violates row-level security policy for table "trips"
--
-- The fix: compare against the date in the launch cities' own time zone
-- instead of UTC. One helper function now defines "today" for the whole
-- database, so the rule, the browse list and the join check all agree.
--
-- Run this once in the Supabase SQL Editor. Safe to re-run.
-- =====================================================================


-- 1. "Today" where the anglers actually are.
--    Change the zone if you ever launch a city outside Eastern time.
create or replace function public.today_local()
returns date
language sql
stable
as $$
  select (now() at time zone 'America/New_York')::date;
$$;


-- 2. Hosting a trip: allow today, in local terms.
alter policy "Users can create trips they host"
  on public.trips
  with check (
    host_id = (select auth.uid())
    and trip_date >= public.today_local()
    and status = 'active'
  );


-- 3. Joining a trip: same definition of "already happened".
create or replace function public.join_trip(p_trip_id bigint, p_needs_gear boolean default false)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user  uuid := auth.uid();
  v_trip  public.trips%rowtype;
  v_taken int;
begin
  if v_user is null then
    raise exception 'Please log in to join a trip.';
  end if;

  select * into v_trip
  from public.trips
  where id = p_trip_id
  for update;

  if not found then
    raise exception 'Trip not found.';
  end if;

  if v_trip.status <> 'active' then
    raise exception 'This trip has been cancelled.';
  end if;

  if v_trip.trip_date < public.today_local() then
    raise exception 'This trip has already happened.';
  end if;

  if v_trip.host_id = v_user then
    raise exception 'You are hosting this trip, so you don''t need to RSVP.';
  end if;

  if exists (select 1 from public.rsvps where trip_id = p_trip_id and user_id = v_user) then
    raise exception 'You are already signed up for this trip.';
  end if;

  select count(*) into v_taken from public.rsvps where trip_id = p_trip_id;

  if v_taken >= v_trip.group_size then
    raise exception 'Sorry, this trip is full.';
  end if;

  insert into public.rsvps (trip_id, user_id, needs_gear)
  values (p_trip_id, v_user, coalesce(p_needs_gear, false));
end;
$$;


-- 4. Browsing: today's trips stay visible all day.
create or replace view public.upcoming_trips
with (security_invoker = true) as
select *
from public.trip_details
where status = 'active'
  and trip_date >= public.today_local();


-- 5. Permissions, unchanged from the original setup.
revoke execute on function public.join_trip(bigint, boolean) from public, anon;
grant  execute on function public.join_trip(bigint, boolean) to authenticated;


-- =====================================================================
-- Check it worked. The second column should be today's date where you
-- are, not tomorrow's.
-- =====================================================================
-- select current_date as utc_date, public.today_local() as local_date;
