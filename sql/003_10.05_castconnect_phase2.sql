-- =====================================================================
-- CastConnect phase 2
--
-- Adds the Milestone 1 user stories that were not in the first build:
--
--   US-4   A visible way to report a problem
--   US-19  A quick-start guide for first-time hosts   (app only, no SQL)
--   US-21  Join a waitlist when a trip is full
--
-- US-23 (repeat no-shows lose sign-up access) was built and then deferred.
-- The rule only triggers after three missed trips across 60 days on trips
-- where a host recorded attendance, which could not be exercised inside the
-- project window, so the team chose not to ship a rule it had no way to
-- test. The check-in data it would need is still stored.
--
-- US-22 (tying an account to a fishing licence number) is deliberately
-- NOT built. The scope statement excludes integration with state
-- licensing systems and requires that the app collect as little personal
-- information as possible. A licence number could not be validated, so
-- storing it would add sensitive data without adding safety.
--
-- Run after castconnect_supabase_setup.sql and castconnect_fix_timezone.sql.
-- =====================================================================


-- =====================================================================
-- 1. PROBLEM REPORTS  (US-4)
-- =====================================================================

create table if not exists public.reports (
  id         bigint generated always as identity primary key,
  user_id    uuid not null references public.profiles(id) on delete cascade,
  category   text not null check (category in
               ('Something is broken', 'Wrong information about a location',
                'A problem with a trip or a person', 'Something else')),
  details    text not null check (char_length(details) between 10 and 2000),
  about_page text,                     -- which screen they were on
  status     text not null default 'open' check (status in ('open', 'closed')),
  created_at timestamptz not null default now()
);

create index if not exists reports_user_idx on public.reports (user_id, created_at desc);

alter table public.reports enable row level security;

drop policy if exists "Users can file a report" on public.reports;
create policy "Users can file a report"
  on public.reports for insert to authenticated
  with check (user_id = (select auth.uid()));

drop policy if exists "Users can read their own reports" on public.reports;
create policy "Users can read their own reports"
  on public.reports for select to authenticated
  using (user_id = (select auth.uid()));

-- Reports are read and closed by the team in the Supabase dashboard.
revoke update, delete on public.reports from anon, authenticated;


-- =====================================================================
-- 2. WAITLIST  (US-21)
-- =====================================================================

create table if not exists public.waitlist (
  trip_id    bigint  not null references public.trips(id) on delete cascade,
  user_id    uuid    not null references public.profiles(id) on delete cascade,
  needs_gear boolean not null default false,
  created_at timestamptz not null default now(),
  primary key (trip_id, user_id)
);

create index if not exists waitlist_order_idx on public.waitlist (trip_id, created_at);

alter table public.waitlist enable row level security;

drop policy if exists "See own waitlist place; hosts see their trip's list" on public.waitlist;
create policy "See own waitlist place; hosts see their trip's list"
  on public.waitlist for select to authenticated
  using (
    user_id = (select auth.uid())
    or exists (
      select 1 from public.trips t
      where t.id = waitlist.trip_id and t.host_id = (select auth.uid())
    )
  );

drop policy if exists "Users can leave the waitlist" on public.waitlist;
create policy "Users can leave the waitlist"
  on public.waitlist for delete to authenticated
  using (user_id = (select auth.uid()));

-- Joining happens through join_waitlist() so the "trip must be full"
-- rule cannot be skipped.
revoke insert, update on public.waitlist from anon, authenticated;


-- How many people are waiting. Elevated rights so everyone sees the
-- real number, never the names.
create or replace function public.waitlist_count(p_trip_id bigint)
returns int
language sql
stable
security definer
set search_path = ''
as $$
  select count(*)::int from public.waitlist where trip_id = p_trip_id;
$$;

-- Where the signed-in user sits in the queue; null if not waiting.
create or replace function public.my_waitlist_place(p_trip_id bigint)
returns int
language sql
stable
security definer
set search_path = ''
as $$
  select place from (
    select user_id, row_number() over (order by created_at) as place
    from public.waitlist where trip_id = p_trip_id
  ) q
  where user_id = auth.uid();
$$;


-- Move people off the waitlist into open spots, oldest first.
create or replace function public.fill_from_waitlist(p_trip_id bigint)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_trip  public.trips%rowtype;
  v_taken int;
  v_next  public.waitlist%rowtype;
begin
  select * into v_trip from public.trips where id = p_trip_id;
  if not found or v_trip.status <> 'active' then
    return;
  end if;

  loop
    select count(*) into v_taken from public.rsvps where trip_id = p_trip_id;
    exit when v_taken >= v_trip.group_size;

    select * into v_next
    from public.waitlist
    where trip_id = p_trip_id
    order by created_at
    limit 1;
    exit when not found;

    insert into public.rsvps (trip_id, user_id, needs_gear)
    values (v_next.trip_id, v_next.user_id, v_next.needs_gear)
    on conflict (trip_id, user_id) do nothing;

    delete from public.waitlist
    where trip_id = v_next.trip_id and user_id = v_next.user_id;
  end loop;
end;
$$;


-- Someone leaves a trip -> the next person on the waitlist takes the spot.
create or replace function public.on_rsvp_removed()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.fill_from_waitlist(old.trip_id);
  return old;
end;
$$;

drop trigger if exists rsvps_fill_from_waitlist on public.rsvps;
create trigger rsvps_fill_from_waitlist
  after delete on public.rsvps
  for each row execute function public.on_rsvp_removed();


-- A host raises the group size -> the waitlist fills the new spots.
create or replace function public.on_group_size_raised()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.group_size > old.group_size then
    perform public.fill_from_waitlist(new.id);
  end if;
  return null;
end;
$$;

drop trigger if exists trips_fill_from_waitlist on public.trips;
create trigger trips_fill_from_waitlist
  after update of group_size on public.trips
  for each row execute function public.on_group_size_raised();


-- Join the waitlist. Only when the trip is genuinely full.
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


-- =====================================================================
-- 3. JOINING A TRIP — now also clears any waitlist place the user was
--    holding.
-- =====================================================================

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


-- =====================================================================
-- 4. VIEWS — add the waitlist count
-- =====================================================================

create or replace view public.trip_details
with (security_invoker = true) as
select
  t.id                 as trip_id,
  t.trip_date,
  t.start_time,
  t.group_size,
  t.status,
  t.host_id,
  hp.display_name      as host_name,
  l.id                 as location_id,
  l.name               as location_name,
  l.address,
  l.latitude,
  l.longitude,
  l.parking_notes,
  l.accessibility_notes,
  c.id                 as city_id,
  c.name               as city_name,
  c.state,
  c.license_url,
  tc.spots_taken,
  greatest(t.group_size - tc.spots_taken, 0) as open_spots,
  tc.gear_requests,
  public.waitlist_count(t.id) as waiting
from public.trips t
join public.profiles  hp on hp.id = t.host_id
join public.locations l  on l.id  = t.location_id
join public.cities    c  on c.id  = l.city_id
cross join lateral public.trip_counts(t.id) tc;

create or replace view public.upcoming_trips
with (security_invoker = true) as
select *
from public.trip_details
where status = 'active'
  and trip_date >= public.today_local();


-- =====================================================================
-- 5. PERMISSIONS
-- =====================================================================
revoke execute on function public.join_waitlist(bigint, boolean)   from public, anon;
revoke execute on function public.waitlist_count(bigint)           from public, anon;
revoke execute on function public.my_waitlist_place(bigint)        from public, anon;
grant  execute on function public.join_waitlist(bigint, boolean)   to authenticated;
grant  execute on function public.waitlist_count(bigint)           to authenticated;
grant  execute on function public.my_waitlist_place(bigint)        to authenticated;

-- Internal only: nothing in the browser should call these directly.
revoke execute on function public.fill_from_waitlist(bigint)  from public, anon, authenticated;
revoke execute on function public.on_rsvp_removed()           from public, anon, authenticated;
revoke execute on function public.on_group_size_raised()      from public, anon, authenticated;


-- =====================================================================
-- Quick check
-- =====================================================================
-- select trip_id, location_name, spots_taken, group_size, waiting from public.upcoming_trips;
