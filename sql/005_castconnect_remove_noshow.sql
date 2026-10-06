-- =====================================================================
-- CastConnect: remove the repeat no-show rule (US-23)
--
-- The rule was built, then deferred. It only triggers after three missed
-- trips across 60 days on trips where a host recorded attendance, which
-- could not be exercised inside the project window, so the team chose not
-- to ship a rule it had no way to test.
--
-- This file takes it back out of an existing database. The waitlist,
-- problem reports and everything else from phase 2 are untouched, and the
-- check-in data the rule would need is still stored, so it can be added
-- back later.
--
-- Run in the Supabase SQL Editor after 003_castconnect_phase2.sql.
-- Safe to re-run.
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1. Joining a trip — same as before, without the no-show check.
-- ---------------------------------------------------------------------
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

  select * into v_trip from public.trips where id = p_trip_id for update;
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

  delete from public.waitlist where trip_id = p_trip_id and user_id = v_user;
end;
$$;


-- ---------------------------------------------------------------------
-- 2. Joining the waitlist — same as before, without the no-show check.
-- ---------------------------------------------------------------------
create or replace function public.join_waitlist(p_trip_id bigint, p_needs_gear boolean default false)
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
    raise exception 'Please log in to join the waitlist.';
  end if;

  select * into v_trip from public.trips where id = p_trip_id for update;
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
    raise exception 'You are hosting this trip.';
  end if;

  if exists (select 1 from public.rsvps where trip_id = p_trip_id and user_id = v_user) then
    raise exception 'You already have a spot on this trip.';
  end if;

  select count(*) into v_taken from public.rsvps where trip_id = p_trip_id;
  if v_taken < v_trip.group_size then
    raise exception 'A spot just opened up — join the trip instead.';
  end if;

  insert into public.waitlist (trip_id, user_id, needs_gear)
  values (p_trip_id, v_user, coalesce(p_needs_gear, false))
  on conflict (trip_id, user_id) do update set needs_gear = excluded.needs_gear;
end;
$$;


-- ---------------------------------------------------------------------
-- 3. Drop the no-show functions. Nothing calls them now.
-- ---------------------------------------------------------------------
drop function if exists public.my_standing();
drop function if exists public.signup_block(uuid);
drop function if exists public.no_show_dates(uuid);


-- ---------------------------------------------------------------------
-- 4. Permissions, unchanged.
-- ---------------------------------------------------------------------
revoke execute on function public.join_trip(bigint, boolean)     from public, anon;
revoke execute on function public.join_waitlist(bigint, boolean) from public, anon;
grant  execute on function public.join_trip(bigint, boolean)     to authenticated;
grant  execute on function public.join_waitlist(bigint, boolean) to authenticated;


-- =====================================================================
-- Check it worked. All three queries should report that the function
-- no longer exists.
-- =====================================================================
-- select proname from pg_proc
-- where proname in ('no_show_dates', 'signup_block', 'my_standing');
