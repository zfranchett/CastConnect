-- =====================================================================
-- CastConnect launch data: 3 cities, 6 public fishing access points
-- Run in the Supabase SQL Editor after the setup file.
-- =====================================================================


-- Clear the placeholder data from testing.
delete from public.locations
where city_id in (select id from public.cities where name = 'Test City');
delete from public.cities where name = 'Test City';


-- ---------------------------------------------------------------------
-- Cities. license_url points at each state's main fishing licence page.
-- ---------------------------------------------------------------------
insert into public.cities (name, state, license_url) values
  ('Philadelphia', 'PA', 'https://www.pa.gov/agencies/fishandboat/fishing/buy-fishing-license-permit'),
  ('New York City', 'NY', 'https://dec.ny.gov/regulatory/permits-licenses/sporting-and-use/sporting/fishing-license'),
  ('Boston', 'MA', 'https://www.mass.gov/how-to/buy-your-freshwater-fishing-license');


-- ---------------------------------------------------------------------
-- PHILADELPHIA
-- ---------------------------------------------------------------------
insert into public.locations
  (city_id, name, address, latitude, longitude, parking_notes, accessibility_notes,
   source_url, verified_by, verified_on)
values
  ((select id from public.cities where name = 'Philadelphia'),
   'Pier 68',
   '1751 S. Columbus Boulevard, Philadelphia, PA 19148',
   39.9230, -75.1400,
   'Reached through the Walmart parking lot at 1675 S Columbus Blvd. Free.',
   'Purpose-built public pier with wheelchair access to prime fishing spots and an accessible pier end. Benches have bored holes that hold a fishing pole. Open daily, dawn to dusk. Pennsylvania licence required.',
   'https://www.phila.gov/2024-06-20-reel-it-in-places-to-go-fishing-in-philadelphia-parks/',
   'Zach Franchett', current_date),

  ((select id from public.cities where name = 'Philadelphia'),
   'Bartram''s Garden Community Boathouse',
   '5400 Lindbergh Boulevard, Philadelphia, PA 19143',
   39.9320, -75.2120,
   'On-site parking at Bartram''s Garden, free.',
   'Floating dock on the Schuylkill River. Free Wednesday evening fishing sessions provide rods, tackle, bait and basic instruction, first come first served; no licence and no registration needed for those sessions. Catch and release. All ages, no experience necessary.',
   'https://www.bartramsgarden.org/boathouse/',
   'Zach Franchett', current_date);


-- ---------------------------------------------------------------------
-- NEW YORK CITY
-- ---------------------------------------------------------------------
insert into public.locations
  (city_id, name, address, latitude, longitude, parking_notes, accessibility_notes,
   source_url, verified_by, verified_on)
values
  ((select id from public.cities where name = 'New York City'),
   'Prospect Park Lake',
   'Prospect Park, Brooklyn, NY 11225',
   40.6520, -73.9680,
   'Parking available at the park. Subway: F or G to 15th St-Prospect Park for the west side, Q to Parkside Ave for the east side. Buses B16, B41, B68, B69.',
   '55-acre lake with a 2.5-mile shoreline and many shore positions accessible to people with disabilities. Lit paths. New York State freshwater licence required from age 16. NYC rules: catch and release, barbless hooks and non-lead weights only.',
   'https://dec.ny.gov/places/prospect-park-lake',
   'Zach Franchett', current_date),

  ((select id from public.cities where name = 'New York City'),
   'Pier 84, Hudson River Park',
   'West 44th Street at the Hudson River, New York, NY 10036',
   40.7640, -74.0000,
   'No dedicated lot. Street parking and nearby commercial garages; accessible by the M42 bus and the 42nd St subway lines.',
   'Level, fully accessible public pier with a dedicated fishing area. Saltwater: perch, flounder, striped bass and eels. Hudson River Park runs free Big City Fishing sessions in season with all equipment provided and an on-site tutorial, ages 5 and up with an adult, no registration. Saltwater fishing needs the NY Recreational Marine Fishing Registry rather than a freshwater licence.',
   'https://www.nycgovparks.org/highlights/places-to-go/fishing',
   'Zach Franchett', current_date);


-- ---------------------------------------------------------------------
-- BOSTON
-- ---------------------------------------------------------------------
insert into public.locations
  (city_id, name, address, latitude, longitude, parking_notes, accessibility_notes,
   source_url, verified_by, verified_on)
values
  ((select id from public.cities where name = 'Boston'),
   'Jamaica Pond',
   'Jamaicaway, Jamaica Plain, Boston, MA 02130',
   42.3170, -71.1200,
   'Street parking on Perkins Street at the northern cove, and on side streets off the Jamaicaway and Pond Street.',
   '65-acre pond whose entire shoreline is reachable on foot paths maintained by the Boston Parks Commission. Stocked with trout each spring and autumn by MassWildlife; also holds largemouth bass, pickerel and perch. No private boats. Massachusetts freshwater licence required. Confirm current path conditions with Boston Parks.',
   'https://www.mass.gov/info-details/jamaica-pond',
   'Zach Franchett', current_date),

  ((select id from public.cities where name = 'Boston'),
   'Castle Island and Pleasure Bay',
   '2010 Day Boulevard, South Boston, MA 02127',
   42.3376, -71.0117,
   'Free parking lot near Fort Independence, plus metered street parking along Day Boulevard.',
   'Managed by the Massachusetts Department of Conservation and Recreation. Accessible trail around Pleasure Bay and accessible restrooms on site. Saltwater shore fishing; a Massachusetts recreational saltwater permit is required rather than a freshwater licence.',
   'https://www.mass.gov/locations/castle-island-pleasure-bay-m-street-beach-and-carson-beach',
   'Zach Franchett', current_date);


-- ---------------------------------------------------------------------
-- Check what landed.
-- ---------------------------------------------------------------------
select c.name as city, l.name as spot, l.address, l.verified_by, l.verified_on
from public.locations l
join public.cities c on c.id = l.city_id
order by c.name, l.name;
