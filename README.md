# CastConnect website

A plain website with no build tools and nothing to install. Four files do everything:

| File | What it is |
| --- | --- |
| `index.html` | The page skeleton. You rarely need to touch it. |
| `config.js` | Your Supabase URL and publishable key. **Edit this first.** |
| `app.js` | All the pages and logic, with comments explaining each part. |
| `style.css` | Colors, fonts, and layout. Colors are defined at the top. |

## Run it on your computer

1. Open `config.js` in Notepad and paste in your Supabase project URL and publishable key.
2. Double-click `index.html` to open it in Chrome, Edge, or Firefox.

## Put it online (free)

1. Create a free account at https://app.netlify.com
2. Drag the whole `castconnect` folder onto Netlify's deploy area.
3. Netlify gives you a web address to share with your team and testers.

To update the site later, drag the folder onto Netlify again.

## Where each requirement lives in app.js

| Requirement | Function |
| --- | --- |
| Register / log in | `pageLogin` |
| Choose and change city | `pageCity` |
| Upcoming trips for the chosen city | `pageTrips` |
| Verified fishing spots (address, parking, accessibility) | `pageSpots` |
| Trip details, RSVP, gear request, leave trip | `pageTrip` |
| Host tools: gear count, check-in, cancel | `pageTrip` (host section) |
| Create and edit trips | `pageHostForm` |
| Confirmations, cancelled trips, waitlist | `pageMyTrips` |
| Waitlist when a trip is full | `pageTrip` (full-trip section) |
| FAQ, safety, host quick-start guide, license links | `pageFaq` |
| Report a problem | `pageReport` |

The important rules (group size cap, privacy, who can edit what, waitlist
order) are enforced in the database, not just in this
code. Run the SQL files in this order on a new project:

1. `001_castconnect_supabase_setup.sql` — tables, security policies, RSVP cap
2. `002_castconnect_fix_timezone.sql` — date checks in Eastern time, not UTC
3. `003_castconnect_phase2.sql` — problem reports and the waitlist
4. `004_castconnect_locations.sql` — the three launch cities and six access points

On a database built before the no-show rule was removed, also run
`005_castconnect_remove_noshow.sql`.

## Known limitations

- Email confirmation needs a custom SMTP provider; Supabase's built-in sender
  is demonstration-only and is filtered by most mail providers.
- Two of the six access points are saltwater, where New York and Massachusetts
  require a different permit from the freshwater licence the city links to.
- Nothing notifies a user when the waitlist gives them a spot. They see it on
  My trips.
- Tying an account to a fishing licence number was requested and rejected: the
  scope statement excludes integration with state licensing systems, and the
  number could not be validated, so storing it would add sensitive data
  without adding safety.
- The repeat no-show restriction was built and then deferred. It only triggers
  after three missed trips across 60 days on trips where a host recorded
  attendance, which could not be tested inside the project window. The
  check-in data it would need is still stored.
