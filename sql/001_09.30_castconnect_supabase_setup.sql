-- =====================================================================
-- CastConnect MVP: Supabase database setup
--
-- How to use: Supabase Dashboard -> SQL Editor -> New query -> paste -> Run.
-- Written for a fresh project; run it once.
--
-- Sections:
--   1. Tables
--   2. Auto-create a profile when someone signs up
--   3. Functions (RSVP cap, host check-in, counts, group-size guard)
--   4. Privacy rules (Row Level Security)
--   5. Views the app reads from
--   6. Seed data template (your 3 cities / 6 locations)
--   7. How the app calls all of this (supabase-js examples)
-- =====================================================================


-- =====================================================================
-- 1. TABLES
-- =====================================================================

create table public.cities (
  id          bigint generated always as identity primary key,
  name        text not null unique,
  state       text not null check (char_length(state) = 2),  -- e.g. 'PA'
  license_url text not null                                    -- official state license & regulations page
);

create table public.locations (
  id                  bigint generated always as identity primary key,
  city_id             bigint not null references public.cities(id),
  name                text not null,
  address             text not null,
  latitude            numeric(9,6) not null,
  longitude           numeric(9,6) not null,
  parking_notes       text,
  accessibility_notes text,  -- distance to water, path conditions, restrooms, limited-mobility suitability
  -- Verification record (backs up the "100% of locations verified" success criterion)
  source_url          text not null,  -- official park/state page used to verify
  verified_by         text not null,  -- team member who checked it
  verified_on         date not null
);

create table public.profiles (
  id           uuid primary key references auth.users(id) on delete cascade,
  display_name text not null check (char_length(display_name) between 1 and 40),
  created_at   timestamptz not null default now()
  -- Deliberately NO email/phone here. Those stay in auth.users, which the app can't query.
);

create table public.trips (
  id          bigint generated always as identity primary key,
  host_id     uuid   not null references public.profiles(id) on delete cascade,
  location_id bigint not null references public.locations(id),
  trip_date   date   not null,
  start_time  time   not null,
  group_size  int    not null check (group_size between 1 and 50),  -- attendee spots, NOT counting the host
  status      text   not null default 'active' check (status in ('active', 'cancelled')),
  created_at  timestamptz not null default now()
);

create table public.rsvps (
  trip_id    bigint  not null references public.trips(id) on delete cascade,
  user_id    uuid    not null references public.profiles(id) on delete cascade,
  needs_gear boolean not null default false,
  checked_in boolean not null default false,
  created_at timestamptz not null default now(),
  primary key (trip_id, user_id)  -- a user can only sign up once per trip
);

create index on public.locations (city_id);
create index on public.trips (location_id, trip_date);
create index on public.trips (host_id);
create index on public.rsvps (user_id);


-- =====================================================================
-- 2. AUTO-CREATE A PROFILE ON SIGN-UP
-- The app passes display_name at sign-up (see section 7).
-- =====================================================================

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, display_name)
  values (
    new.id,
    coalesce(nullif(trim(new.raw_user_meta_data ->> 'display_name'), ''), 'Angler')
  );
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();


-- =====================================================================
-- 3. FUNCTIONS
-- =====================================================================

-- 3z. "Today" in the launch cities' own time zone. The database runs on UTC,
-- so after about 8pm Eastern it already thinks it is tomorrow, which would
-- reject a trip the host dated today. Change the zone if you launch a city
-- outside Eastern time.
create or replace function public.today_local()
returns date
language sql
stable
as $$
  select (now() at time zone 'America/New_York')::date;
$$;


-- 3a. Spots taken + gear requests for a trip.
-- Runs with elevated rights so the counts are correct even though
-- regular users can only see their own RSVP row. Returns numbers only,
-- never names.
create or replace function public.trip_counts(p_trip_id bigint)
returns table (spots_taken int, gear_requests int)
language sql
stable
security definer
set search_path = ''
as $$
  select count(*)::int,
         (count(*) filter (where needs_gear))::int
  from public.rsvps
  where trip_id = p_trip_id;
$$;


-- 3b. JOIN A TRIP (the only way to create an RSVP).
-- Locks the trip row first, so two people can't take the last spot
-- at the same moment.
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


-- 3c. HOST CHECK-IN. Only the trip's host can mark attendance.
create or replace function public.set_check_in(p_trip_id bigint, p_user_id uuid, p_checked_in boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (
    select 1 from public.trips
    where id = p_trip_id and host_id = auth.uid()
  ) then
    raise exception 'Only the host of this trip can check people in.';
  end if;

  update public.rsvps
  set checked_in = p_checked_in
  where trip_id = p_trip_id and user_id = p_user_id;

  if not found then
    raise exception 'That person is not signed up for this trip.';
  end if;
end;
$$;


-- 3d. GUARD: a host can't shrink group_size below the number already signed up.
create or replace function public.check_group_size_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_taken int;
begin
  if new.group_size < old.group_size then
    select count(*) into v_taken from public.rsvps where trip_id = new.id;
    if v_taken > new.group_size then
      raise exception 'Group size can''t be lower than the % people already signed up.', v_taken;
    end if;
  end if;
  return new;
end;
$$;

create trigger trips_group_size_guard
  before update of group_size on public.trips
  for each row execute function public.check_group_size_change();


-- Function permissions: only logged-in users can call the app functions.
revoke execute on function public.trip_counts(bigint)              from public, anon;
revoke execute on function public.join_trip(bigint, boolean)       from public, anon;
revoke execute on function public.set_check_in(bigint, uuid, boolean) from public, anon;
grant  execute on function public.trip_counts(bigint)              to authenticated;
grant  execute on function public.join_trip(bigint, boolean)       to authenticated;
grant  execute on function public.set_check_in(bigint, uuid, boolean) to authenticated;

-- Trigger-only functions shouldn't be callable from the app at all.
revoke execute on function public.handle_new_user()         from public, anon, authenticated;
revoke execute on function public.check_group_size_change() from public, anon, authenticated;


-- =====================================================================
-- 4. PRIVACY RULES (ROW LEVEL SECURITY)
-- With RLS on, anything not explicitly allowed below is blocked.
-- =====================================================================

alter table public.cities    enable row level security;
alter table public.locations enable row level security;
alter table public.profiles  enable row level security;
alter table public.trips     enable row level security;
alter table public.rsvps     enable row level security;

-- Cities & locations: public, read-only. (The team edits them in the dashboard.)
create policy "Anyone can read cities"
  on public.cities for select to anon, authenticated
  using (true);

create policy "Anyone can read locations"
  on public.locations for select to anon, authenticated
  using (true);

-- Profiles: logged-in users can see display names; you can only edit your own.
create policy "Logged-in users can read display names"
  on public.profiles for select to authenticated
  using (true);

create policy "Users can update their own profile"
  on public.profiles for update to authenticated
  using (id = (select auth.uid()))
  with check (id = (select auth.uid()));

-- Trips: logged-in users can browse; anyone logged in can host;
-- only the host can edit or cancel. No deletes: cancel instead.
create policy "Logged-in users can read trips"
  on public.trips for select to authenticated
  using (true);

create policy "Users can create trips they host"
  on public.trips for insert to authenticated
  with check (
    host_id = (select auth.uid())
    and trip_date >= public.today_local()
    and status = 'active'
  );

create policy "Hosts can edit or cancel their own trips"
  on public.trips for update to authenticated
  using (host_id = (select auth.uid()))
  with check (host_id = (select auth.uid()));

-- RSVPs: you see your own; a host sees RSVPs for their trips.
-- Other attendees can't see who else signed up.
create policy "Users see own RSVPs; hosts see RSVPs for their trips"
  on public.rsvps for select to authenticated
  using (
    user_id = (select auth.uid())
    or exists (
      select 1 from public.trips t
      where t.id = rsvps.trip_id
        and t.host_id = (select auth.uid())
    )
  );

create policy "Users can change their own gear request"
  on public.rsvps for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

create policy "Users can leave a trip"
  on public.rsvps for delete to authenticated
  using (user_id = (select auth.uid()));

-- No INSERT policy on rsvps: joining only happens through join_trip(),
-- which enforces the group size cap.
-- Column-level lock: attendees may only change needs_gear, never checked_in
-- (check-in goes through set_check_in(), host only).
revoke insert, update on public.rsvps from anon, authenticated;
grant  update (needs_gear) on public.rsvps to authenticated;


-- =====================================================================
-- 5. VIEWS THE APP READS FROM
-- security_invoker = true means the privacy rules above still apply.
-- =====================================================================

-- Everything about a trip in one row (includes cancelled trips, for "My trips").
create view public.trip_details
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
  tc.gear_requests
from public.trips t
join public.profiles  hp on hp.id = t.host_id
join public.locations l  on l.id  = t.location_id
join public.cities    c  on c.id  = l.city_id
cross join lateral public.trip_counts(t.id) tc;

-- The browse list: active, not in the past. Cancelled trips can never show here.
create view public.upcoming_trips
with (security_invoker = true) as
select *
from public.trip_details
where status = 'active'
  and trip_date >= public.today_local();


-- =====================================================================
-- 6. SEED DATA TEMPLATE
-- Fill in the placeholders with your verified data, uncomment, and run.
-- =====================================================================

-- insert into public.cities (name, state, license_url) values
--   ('<City 1>', '<ST>', '<official state license & regulations URL>'),
--   ('<City 2>', '<ST>', '<official state license & regulations URL>'),
--   ('<City 3>', '<ST>', '<official state license & regulations URL>');

-- insert into public.locations
--   (city_id, name, address, latitude, longitude, parking_notes, accessibility_notes,
--    source_url, verified_by, verified_on)
-- values
--   ((select id from public.cities where name = '<City 1>'),
--    '<Access point name>', '<Street address>', 00.000000, -00.000000,
--    '<Parking details>',
--    '<Distance to water, path conditions, restrooms, limited-mobility suitability>',
--    '<Official park/state URL>', '<Team member>', '2026-09-20');
--   -- ...repeat for all 6 locations (2 per city)


-- =====================================================================
-- 7. HOW THE APP CALLS THIS (supabase-js)
-- =====================================================================
--
-- Sign up (display name is stored in profiles automatically):
--   supabase.auth.signUp({ email, password, options: { data: { display_name: 'Zach' } } })
--
-- Remember the chosen city (private to the user, works across devices):
--   supabase.auth.updateUser({ data: { city_id: 1 } })
--   // read it back: (await supabase.auth.getUser()).data.user.user_metadata.city_id
--
-- City picker:
--   supabase.from('cities').select('*').order('name')
--
-- Browse trips for the selected city:
--   supabase.from('upcoming_trips').select('*')
--     .eq('city_id', cityId).order('trip_date').order('start_time')
--
-- Locations for the create-trip form:
--   supabase.from('locations').select('*').eq('city_id', cityId)
--
-- Join a trip (show error.message to the user if it fails, e.g. "Sorry, this trip is full."):
--   supabase.rpc('join_trip', { p_trip_id: tripId, p_needs_gear: true })
--
-- My trips (includes cancelled ones, so show a "Cancelled" label when status = 'cancelled'):
--   const { data: mine } = await supabase.from('rsvps').select('trip_id').eq('user_id', user.id)
--   supabase.from('trip_details').select('*').in('trip_id', mine.map(r => r.trip_id))
--
-- Change gear request / leave a trip:
--   supabase.from('rsvps').update({ needs_gear: false }).eq('trip_id', tripId).eq('user_id', user.id)
--   supabase.from('rsvps').delete().eq('trip_id', tripId).eq('user_id', user.id)
--
-- Host a trip / cancel it:
--   supabase.from('trips').insert({ host_id: user.id, location_id, trip_date, start_time, group_size })
--   supabase.from('trips').update({ status: 'cancelled' }).eq('id', tripId)
--
-- Host view: attendee names, gear requests, check-in:
--   supabase.from('rsvps').select('user_id, needs_gear, checked_in, profiles(display_name)').eq('trip_id', tripId)
--   supabase.rpc('set_check_in', { p_trip_id: tripId, p_user_id: attendeeId, p_checked_in: true })
--
-- "Open in Google Maps" link from a location:
--   `https://www.google.com/maps/search/?api=1&query=${latitude},${longitude}`
-- =====================================================================
