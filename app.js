// =====================================================================
// CastConnect app
//
// How this file is organized:
//   1. Setup
//   2. Small helpers (formatting dates, safe text, etc.)
//   3. The router: decides which page to show from the address bar
//   4. One function per page (login, city, trips, trip, host, my trips, FAQ)
//
// The page shown depends on the part of the web address after "#".
// For example  index.html#/trip/12  shows trip number 12.
// =====================================================================


// ---------------------------------------------------------------------
// 1. SETUP
// ---------------------------------------------------------------------

const app = document.getElementById('app');
const nav = document.getElementById('nav');
const cityBox = document.getElementById('city');
const noticeBox = document.getElementById('notice');

const configMissing =
  typeof SUPABASE_URL === 'undefined' ||
  typeof SUPABASE_KEY === 'undefined' ||
  SUPABASE_URL.includes('YOUR-PROJECT') ||
  SUPABASE_KEY.includes('YOUR-');

const db = (typeof supabase !== 'undefined' && !configMissing)
  ? supabase.createClient(SUPABASE_URL, SUPABASE_KEY)
  : null;

// Things the app remembers while it's open
const state = {
  user: null,     // the logged-in user, or null
  cityId: null,   // the city they picked
  cities: [],     // list of all cities
  notice: null,   // a one-time message to show on the next page, e.g. "Trip posted."
};

let renderCount = 0; // used to ignore slow page loads if the user already clicked elsewhere


// ---------------------------------------------------------------------
// 2. HELPERS
// ---------------------------------------------------------------------

// Makes any text safe to put on the page (stops people from injecting code
// through things like their display name).
function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// Only allow real web links (http/https).
function safeUrl(url) {
  return /^https?:\/\//i.test(url || '') ? url : '#';
}

// Today's date as "YYYY-MM-DD" in the user's own time zone
function todayStr() {
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}

function parseDate(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(y, m - 1, d);
}

// "2026-10-10" -> "Saturday, October 10"
function formatDate(dateStr) {
  return parseDate(dateStr).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
}

// "07:30:00" -> "7:30 AM"
function formatTime(timeStr) {
  const [h, m] = timeStr.split(':').map(Number);
  return new Date(2000, 0, 1, h, m).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

function mapsUrl(lat, lng) {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(lat)},${encodeURIComponent(lng)}`;
}

function cityById(id) {
  return state.cities.find((c) => c.id === Number(id)) || null;
}

function errorBox(message) {
  return `<p class="error" role="alert">${esc(message)}</p>`;
}

// Go to another page, optionally with a message to show there.
function go(path, notice) {
  if (notice) state.notice = notice;
  if (location.hash === '#' + path) render();
  else location.hash = path;
}

// Row of bobber dots: filled = spot taken, dashed = spot open
function spotsHtml(taken, size) {
  const left = Math.max(size - taken, 0);
  const label = left === 0 ? 'Full' : `${left} of ${size} ${size === 1 ? 'spot' : 'spots'} open`;
  const dots = size <= 20
    ? `<span class="dots" aria-hidden="true">${
        Array.from({ length: size }, (_, i) => `<span class="dot ${i < taken ? 'taken' : 'open'}"></span>`).join('')
      }</span>`
    : '';
  return `<span class="spots">${dots}<span class="spots-label">${esc(label)}</span></span>`;
}

// One trip in a list
function tripRow(trip, goingIds) {
  const d = parseDate(trip.trip_date);
  const currentCity = Number(state.cityId);
  const place = trip.city_id !== currentCity
    ? `${trip.location_name}, ${trip.city_name}`
    : trip.location_name;

  let tag = '';
  if (trip.host_id === state.user.id) tag = `<span class="tag">You're hosting</span>`;
  else if (goingIds.has(trip.trip_id)) tag = `<span class="tag">You're going</span>`;

  const right = trip.status === 'cancelled'
    ? `<span class="tag cancelled row-status">Cancelled</span>`
    : spotsHtml(trip.spots_taken, trip.group_size);

  return `
    <li>
      <a class="trip-row" href="#/trip/${trip.trip_id}">
        <span class="datestamp" aria-hidden="true">
          <span class="dow">${esc(d.toLocaleDateString(undefined, { weekday: 'short' }))}</span>
          <span class="day">${d.getDate()}</span>
          <span class="mon">${esc(d.toLocaleDateString(undefined, { month: 'short' }))}</span>
        </span>
        <span class="trip-info">
          <span class="sr-only">${esc(formatDate(trip.trip_date))}</span>
          <strong class="trip-place">${esc(place)}</strong>
          <span>${esc(formatTime(trip.start_time))}, hosted by ${esc(trip.host_name)}</span>
          ${tag}
        </span>
        ${right}
      </a>
    </li>`;
}

// Address, map link, parking and accessibility for a fishing spot
function locationDetails(loc) {
  return `
    <p class="address">${esc(loc.address)}<br>
      <a href="${mapsUrl(loc.latitude, loc.longitude)}" target="_blank" rel="noopener">Open in Google Maps</a>
    </p>
    <dl class="facts">
      <dt>Parking</dt><dd>${esc(loc.parking_notes || 'No parking details yet.')}</dd>
      <dt>Accessibility</dt><dd>${esc(loc.accessibility_notes || 'No accessibility details yet.')}</dd>
    </dl>`;
}

function licenseLink(city) {
  if (!city) return '';
  return `<a href="${esc(safeUrl(city.license_url))}" target="_blank" rel="noopener">${esc(city.state)} fishing licenses and regulations</a>`;
}


// ---------------------------------------------------------------------
// 3. ROUTER
// ---------------------------------------------------------------------

async function render() {
  const token = ++renderCount;
  // Only writes to the page if the user hasn't moved on to another page meanwhile
  const put = (html) => {
    if (token !== renderCount) return false;
    app.innerHTML = html;
    return true;
  };

  const hash = location.hash.replace(/^#/, '') || '/trips';
  const [, page = 'trips', id] = hash.split('/');

  const { data: { session } } = await db.auth.getSession();
  state.user = session ? session.user : null;
  if (!state.user) state.cityId = null;

  if (!state.cities.length) {
    const { data, error } = await db.from('cities').select('*').order('name');
    if (error) {
      renderNav(page);
      put(errorBox(`Couldn't connect to the database: ${error.message}. Check the values in config.js.`));
      return;
    }
    state.cities = data;
  }

  if (state.user && state.cityId == null) {
    state.cityId = state.user.user_metadata?.city_id ?? null;
  }
  if (state.cityId != null && !cityById(state.cityId)) {
    state.cityId = null; // their saved city was removed
  }

  // Redirects
  const publicPages = ['login', 'faq'];
  if (!state.user && !publicPages.includes(page)) return go('/login');
  if (state.user && page === 'login') return go('/trips');
  const needsCity = ['trips', 'spots', 'host'];
  if (state.user && needsCity.includes(page) && state.cityId == null) return go('/city');

  renderNav(page);

  const notice = state.notice;
  state.notice = null;
  noticeBox.innerHTML = notice ? `<p class="notice" role="status">${esc(notice)}</p>` : '';

  const pages = {
    login: pageLogin,
    city: pageCity,
    trips: pageTrips,
    spots: pageSpots,
    trip: pageTrip,
    host: pageHostForm,
    edit: pageHostForm,
    my: pageMyTrips,
    faq: pageFaq,
    report: pageReport,
  };
  const showPage = pages[page] || pageTrips;

  app.innerHTML = '<p class="loading">Loading…</p>';
  window.scrollTo(0, 0);

  try {
    await showPage({ page, id, put });
  } catch (err) {
    console.error(err);
    put(errorBox(`Something went wrong loading this page (${err.message || err}). Check your connection and try again.`));
  }

  if (token === renderCount) {
    const heading = app.querySelector('h1');
    if (heading) {
      heading.setAttribute('tabindex', '-1');
      heading.focus({ preventScroll: true });
    }
  }
}

function renderNav(page) {
  const current = (p) => (p === page ? ' aria-current="page"' : '');

  if (!state.user) {
    cityBox.innerHTML = '';
    nav.innerHTML = `
      <a href="#/faq"${current('faq')}>FAQ and safety</a>
      <a href="#/login"${current('login')}>Log in</a>`;
    return;
  }

  const city = cityById(state.cityId);
  cityBox.innerHTML = city
    ? `<a class="city-switch" href="#/city"${current('city')}>${esc(city.name)}<span>Change city</span></a>`
    : '';

  const links = [
    ['trips', 'Trips'],
    ['spots', 'Fishing spots'],
    ['my', 'My trips'],
    ['host', 'Host a trip'],
    ['faq', 'FAQ and safety'],
  ];
  nav.innerHTML = `
    ${links.map(([p, label]) => `<a href="#/${p}"${current(p)}>${esc(label)}</a>`).join('')}
    <button type="button" class="linklike" id="logout">Log out</button>`;

  document.getElementById('logout').onclick = async () => {
    await db.auth.signOut();
    state.cityId = null;
    go('/login', "You're logged out.");
  };
}


// ---------------------------------------------------------------------
// 4. PAGES
// ---------------------------------------------------------------------

// ----- Log in / create account -----
async function pageLogin({ put }) {
  let mode = 'login';

  function draw() {
    const signup = mode === 'signup';
    if (!put(`
      <section class="intro">
        <h1>Go fishing with people near you</h1>
        <p>Join a beginner-friendly fishing trip at a public spot in your city. No gear? Say so when you sign up, and someone can bring a spare.</p>
      </section>

      <form id="auth-form" class="panel stack" novalidate>
        <h2 class="form-title">${signup ? 'Create an account' : 'Log in'}</h2>
        ${signup ? `
          <label class="field">Display name
            <input name="display_name" required maxlength="40" autocomplete="nickname">
            <span class="hint">Other members see this name. A first name or nickname works best.</span>
          </label>` : ''}
        <label class="field">Email
          <input name="email" type="email" required autocomplete="email">
          ${signup ? '<span class="hint">Never shown to other members.</span>' : ''}
        </label>
        <label class="field">Password
          <input name="password" type="password" required minlength="6" autocomplete="${signup ? 'new-password' : 'current-password'}">
          ${signup ? '<span class="hint">At least 6 characters.</span>' : ''}
        </label>
        <div class="form-msg"></div>
        <button class="btn primary" type="submit">${signup ? 'Create account' : 'Log in'}</button>
        <p>${signup
          ? 'Already have an account? <button type="button" class="linklike" id="switch-mode">Log in</button>'
          : 'New to CastConnect? <button type="button" class="linklike" id="switch-mode">Create an account</button>'}
        </p>
      </form>`)) return;

    const form = document.getElementById('auth-form');
    const msg = form.querySelector('.form-msg');
    const button = form.querySelector('button[type="submit"]');

    document.getElementById('switch-mode').onclick = () => {
      mode = signup ? 'login' : 'signup';
      draw();
    };

    form.onsubmit = async (event) => {
      event.preventDefault();
      const f = new FormData(form);
      const email = String(f.get('email') || '').trim();
      const password = String(f.get('password') || '');
      const displayName = String(f.get('display_name') || '').trim();

      if (signup && !displayName) return (msg.innerHTML = errorBox('Enter a display name.'));
      if (!email) return (msg.innerHTML = errorBox('Enter your email address.'));
      if (password.length < 6) return (msg.innerHTML = errorBox('Passwords need at least 6 characters.'));

      button.disabled = true;
      msg.innerHTML = '';

      if (!signup) {
        const { error } = await db.auth.signInWithPassword({ email, password });
        button.disabled = false;
        if (error) {
          // Supabase says "Email not confirmed" when the link was never clicked,
          // or when a mail scanner opened it first and used it up.
          if (/not confirmed/i.test(error.message)) {
            msg.innerHTML = errorBox('This account still needs its email confirmed.')
              + '<p><button type="button" class="linklike" id="resend">Send a new confirmation email</button></p>';
            document.getElementById('resend').onclick = async (e) => {
              e.target.disabled = true;
              const res = await db.auth.resend({ type: 'signup', email });
              msg.innerHTML = res.error
                ? errorBox(res.error.message)
                : `<p class="saved" role="status">New link sent to ${esc(email)}. Open it on this device, and use it within the hour.</p>`;
            };
            return;
          }
          msg.innerHTML = errorBox(error.message === 'Invalid login credentials'
            ? "That email and password don't match an account."
            : error.message);
          return;
        }
        go('/trips');
      } else {
        const { data, error } = await db.auth.signUp({
          email,
          password,
          options: { data: { display_name: displayName } },
        });
        button.disabled = false;
        if (error) return (msg.innerHTML = errorBox(error.message));
        if (!data.session) {
          // Email confirmation is turned on in Supabase
          mode = 'login';
          draw();
          noticeBox.innerHTML = '<p class="notice" role="status">Account created. Check your email for a confirmation link, then log in.</p>';
          return;
        }
        go('/city', `Welcome, ${displayName}. Pick your city to see trips.`);
      }
    };
  }

  draw();
}


// ----- Choose a city -----
async function pageCity({ put }) {
  if (!state.cities.length) {
    put(`<h1>Choose your city</h1><p>No cities have been added yet.</p>`);
    return;
  }

  const selected = Number(state.cityId);
  if (!put(`
    <h1>Choose your city</h1>
    <p>You'll see trips and fishing spots for this city. You can change it any time.</p>
    <div class="city-list">
      ${state.cities.map((c) => `
        <button type="button" class="city-option${c.id === selected ? ' selected' : ''}" data-id="${c.id}" aria-pressed="${c.id === selected}">
          <strong>${esc(c.name)}</strong><span>${esc(c.state)}</span>
        </button>`).join('')}
    </div>
    <div class="form-msg"></div>`)) return;

  app.querySelectorAll('.city-option').forEach((button) => {
    button.onclick = async () => {
      const id = Number(button.dataset.id);
      button.disabled = true;
      const { error } = await db.auth.updateUser({ data: { city_id: id } });
      button.disabled = false;
      if (error) {
        app.querySelector('.form-msg').innerHTML = errorBox(error.message);
        return;
      }
      state.cityId = id;
      go('/trips', `Showing trips in ${cityById(id).name}.`);
    };
  });
}


// ----- Upcoming trips in the chosen city -----
async function pageTrips({ put }) {
  const city = cityById(state.cityId);

  const [tripsRes, mineRes] = await Promise.all([
    db.from('upcoming_trips').select('*')
      .eq('city_id', city.id)
      .order('trip_date').order('start_time'),
    db.from('rsvps').select('trip_id').eq('user_id', state.user.id),
  ]);
  if (tripsRes.error) throw tripsRes.error;
  if (mineRes.error) throw mineRes.error;

  const trips = tripsRes.data;
  const goingIds = new Set(mineRes.data.map((r) => r.trip_id));

  put(`
    <div class="page-head">
      <h1>Upcoming trips in ${esc(city.name)}</h1>
      ${trips.length ? '<a class="btn secondary" href="#/host">Host a trip</a>' : ''}
    </div>
    ${trips.length
      ? `<ul class="trip-list">${trips.map((t) => tripRow(t, goingIds)).join('')}</ul>`
      : `<div class="empty">
           <p><strong>No trips are planned in ${esc(city.name)} yet.</strong></p>
           <p>Pick a fishing spot and a time, and others can join you.</p>
           <a class="btn primary" href="#/host">Host the first trip</a>
         </div>`}
  `);
}


// ----- Fishing spots in the chosen city -----
async function pageSpots({ put }) {
  const city = cityById(state.cityId);
  const { data, error } = await db.from('locations').select('*').eq('city_id', city.id).order('name');
  if (error) throw error;

  put(`
    <h1>Fishing spots in ${esc(city.name)}</h1>
    <p>Every spot is a public access point checked against an official park or state website. Before you go, check ${licenseLink(city)}.</p>
    ${data.length
      ? `<ul class="spot-list">${data.map((loc) => `
          <li>
            <h2>${esc(loc.name)}</h2>
            ${locationDetails(loc)}
            <p class="hint">Checked on ${esc(formatDate(loc.verified_on))} against <a href="${esc(safeUrl(loc.source_url))}" target="_blank" rel="noopener">the official source</a>.</p>
          </li>`).join('')}</ul>`
      : '<div class="empty"><p>No fishing spots have been added for this city yet.</p></div>'}
  `);
}


// ----- One trip: details, join/leave, and host tools -----
async function pageTrip({ id, put }) {
  const tripId = Number(id);
  const notFound = `
    <h1>Trip not found</h1>
    <p>This trip may have been removed. <a href="#/trips">See upcoming trips</a></p>`;
  if (!Number.isInteger(tripId)) return void put(notFound);

  const { data: trip, error } = await db.from('trip_details').select('*').eq('trip_id', tripId).maybeSingle();
  if (error) throw error;
  if (!trip) return void put(notFound);

  const userId = state.user.id;
  const isHost = trip.host_id === userId;
  const isCancelled = trip.status === 'cancelled';
  const isPast = trip.trip_date < todayStr();
  const isFull = trip.spots_taken >= trip.group_size;
  const city = cityById(trip.city_id);

  // Host sees everyone who signed up; everyone else only sees their own sign-up
  let attendees = [];
  let mine = null;
  if (isHost) {
    const res = await db.from('rsvps')
      .select('user_id, needs_gear, checked_in, profiles(display_name)')
      .eq('trip_id', tripId)
      .order('created_at');
    if (res.error) throw res.error;
    attendees = res.data;
  } else {
    const res = await db.from('rsvps')
      .select('needs_gear, checked_in')
      .eq('trip_id', tripId).eq('user_id', userId)
      .maybeSingle();
    if (res.error) throw res.error;
    mine = res.data;
  }

  // Where this user sits on the waitlist, or null if they are not waiting.
  let place = null;
  if (!isHost && !isCancelled && !isPast && !mine) {
    const placeRes = await db.rpc('my_waitlist_place', { p_trip_id: tripId });
    if (!placeRes.error) place = placeRes.data;
  }

  // The box of actions, which depends on who you are and the trip's state
  let actions = '';
  if (isHost) {
    actions = `
      <div class="panel">
        <p><strong>You're hosting this trip.</strong></p>
        ${!isCancelled ? `
          <div class="row">
            <a class="btn secondary" href="#/edit/${tripId}">Edit trip</a>
            <button type="button" class="btn danger" id="cancel-trip">Cancel trip</button>
          </div>` : ''}
        <h2>Who's coming (${attendees.length} of ${trip.group_size})</h2>
        ${attendees.length ? `
          <p class="hint">When people arrive, check them in.</p>
          <ul class="attendees">
            ${attendees.map((a) => `
              <li>
                <span class="attendee-name">${esc(a.profiles?.display_name || 'Member')}
                  ${a.needs_gear ? '<span class="tag gear">Needs gear</span>' : ''}
                </span>
                <label class="check">
                  <input type="checkbox" class="check-in" data-user="${esc(a.user_id)}"${a.checked_in ? ' checked' : ''}>
                  Arrived
                </label>
              </li>`).join('')}
          </ul>` : '<p>No one has signed up yet.</p>'}
        ${trip.waiting > 0 ? `
          <p class="hint">${trip.waiting} ${trip.waiting === 1 ? 'person is' : 'people are'} on the waitlist.
          If someone drops out, the next one takes their spot automatically. Raising the group size does the same.</p>` : ''}
        <div class="form-msg"></div>
      </div>`;
  } else if (isCancelled) {
    actions = mine ? '<p>You were signed up for this trip.</p>' : '';
  } else if (isPast) {
    if (mine) actions = `<p>${mine.checked_in ? 'You checked in on this trip.' : 'You were signed up for this trip.'}</p>`;
  } else if (mine) {
    actions = `
      <div class="panel going">
        <p><strong>You're going.</strong> Your spot is confirmed.</p>
        <label class="check">
          <input type="checkbox" id="gear"${mine.needs_gear ? ' checked' : ''}>
          I need to borrow gear
        </label>
        <div class="row"><button type="button" class="btn secondary" id="leave">Leave trip</button></div>
        <div class="form-msg"></div>
      </div>`;
  } else if (place) {
    actions = `
      <div class="panel">
        <p><strong>You're ${place === 1 ? 'next on the waitlist' : `number ${place} on the waitlist`}.</strong>
        If someone drops out you'll be given their spot automatically, so check My trips before you set off.</p>
        <div class="row"><button type="button" class="btn secondary" id="leave-waitlist">Leave the waitlist</button></div>
        <div class="form-msg"></div>
      </div>`;
  } else if (isFull) {
    actions = `
      <div class="panel">
        <p><strong>This trip is full.</strong>${trip.waiting > 0
          ? ` ${trip.waiting} ${trip.waiting === 1 ? 'person is' : 'people are'} waiting.`
          : ''} Join the waitlist and you'll get the next spot that opens up.</p>
        <label class="check">
          <input type="checkbox" id="gear">
          I need to borrow gear
        </label>
        <div class="row"><button type="button" class="btn primary" id="join-waitlist">Join the waitlist</button></div>
        <div class="form-msg"></div>
      </div>`;
  } else {
    actions = `
      <div class="panel">
        <label class="check">
          <input type="checkbox" id="gear">
          I need to borrow gear
        </label>
        <p class="hint">The host will see how many people need gear. Spare gear is arranged between members at the meetup and isn't guaranteed.</p>
        <div class="row"><button type="button" class="btn primary" id="join">Join this trip</button></div>
        <div class="form-msg"></div>
      </div>`;
  }

  if (!put(`
    <p class="back"><a href="#/trips">Back to trips</a></p>
    ${isCancelled ? `<p class="banner cancelled" role="status">${isHost
      ? '<strong>You cancelled this trip.</strong> Members who signed up see that it is cancelled.'
      : '<strong>This trip was cancelled by the host.</strong> Don\'t go to the meeting place for this trip.'}</p>` : ''}
    ${!isCancelled && isPast ? '<p class="banner">This trip has already happened.</p>' : ''}

    <h1>${esc(trip.location_name)}</h1>
    <p class="when">${esc(formatDate(trip.trip_date))} at ${esc(formatTime(trip.start_time))}</p>
    <p>Hosted by <strong>${esc(trip.host_name)}</strong></p>
    ${!isCancelled ? `<p>${spotsHtml(trip.spots_taken, trip.group_size)}</p>` : ''}
    ${!isCancelled && trip.gear_requests > 0
      ? `<p>${trip.gear_requests} ${trip.gear_requests === 1 ? 'person needs' : 'people need'} to borrow gear. If you have spares, consider bringing them.</p>`
      : ''}
    ${!isCancelled && !isPast && !isHost && trip.waiting > 0 && !place
      ? `<p>${trip.waiting} ${trip.waiting === 1 ? 'person is' : 'people are'} on the waitlist.</p>`
      : ''}

    <div class="actions">${actions}</div>

    <section>
      <h2>Meeting place</h2>
      <p><strong>${esc(trip.location_name)}</strong>, ${esc(trip.city_name)}</p>
      ${locationDetails(trip)}
    </section>

    <section>
      <h2>License and rules</h2>
      <p>Check whether you need a fishing license before you go: ${licenseLink(city)}.</p>
      <p><a href="#/faq">What to bring and safety tips</a></p>
    </section>
  `)) return;

  // ----- Button actions -----
  const msg = app.querySelector('.form-msg');
  const showError = (text) => { if (msg) msg.innerHTML = errorBox(text); };

  const joinButton = document.getElementById('join');
  if (joinButton) {
    joinButton.onclick = async () => {
      joinButton.disabled = true;
      const { error } = await db.rpc('join_trip', {
        p_trip_id: tripId,
        p_needs_gear: document.getElementById('gear').checked,
      });
      if (error) {
        joinButton.disabled = false;
        return showError(error.message);
      }
      go(`/trip/${tripId}`, "You're signed up. See you there!");
    };
  }

  const waitButton = document.getElementById('join-waitlist');
  if (waitButton) {
    waitButton.onclick = async () => {
      waitButton.disabled = true;
      const { error } = await db.rpc('join_waitlist', {
        p_trip_id: tripId,
        p_needs_gear: document.getElementById('gear').checked,
      });
      if (error) {
        waitButton.disabled = false;
        return showError(error.message);
      }
      go(`/trip/${tripId}`, "You're on the waitlist. We'll give you the next spot that opens up.");
    };
  }

  const leaveWaitButton = document.getElementById('leave-waitlist');
  if (leaveWaitButton) {
    leaveWaitButton.onclick = async () => {
      leaveWaitButton.disabled = true;
      const { error } = await db.from('waitlist').delete().eq('trip_id', tripId).eq('user_id', userId);
      if (error) {
        leaveWaitButton.disabled = false;
        return showError(error.message);
      }
      go(`/trip/${tripId}`, "You've left the waitlist.");
    };
  }

  const leaveButton = document.getElementById('leave');
  if (leaveButton) {
    leaveButton.onclick = async () => {
      if (!confirm('Leave this trip? Your spot will open up for someone else.')) return;
      leaveButton.disabled = true;
      const { error } = await db.from('rsvps').delete().eq('trip_id', tripId).eq('user_id', userId);
      if (error) {
        leaveButton.disabled = false;
        return showError(error.message);
      }
      go(`/trip/${tripId}`, "You've left this trip.");
    };
  }

  const gearBox = document.getElementById('gear');
  if (gearBox && mine) {
    gearBox.onchange = async () => {
      const wanted = gearBox.checked;
      const { error } = await db.from('rsvps').update({ needs_gear: wanted }).eq('trip_id', tripId).eq('user_id', userId);
      if (error) {
        gearBox.checked = !wanted;
        return showError(error.message);
      }
      if (msg) msg.innerHTML = `<p class="saved" role="status">${wanted ? 'The host will see that you need gear.' : 'Gear request removed.'}</p>`;
    };
  }

  const cancelButton = document.getElementById('cancel-trip');
  if (cancelButton) {
    cancelButton.onclick = async () => {
      if (!confirm('Cancel this trip? Everyone signed up will see that it is cancelled. This can\'t be undone in the app.')) return;
      cancelButton.disabled = true;
      const { error } = await db.from('trips').update({ status: 'cancelled' }).eq('id', tripId);
      if (error) {
        cancelButton.disabled = false;
        return showError(error.message);
      }
      go(`/trip/${tripId}`, 'Trip cancelled.');
    };
  }

  app.querySelectorAll('.check-in').forEach((box) => {
    box.onchange = async () => {
      const arrived = box.checked;
      const { error } = await db.rpc('set_check_in', {
        p_trip_id: tripId,
        p_user_id: box.dataset.user,
        p_checked_in: arrived,
      });
      if (error) {
        box.checked = !arrived;
        showError(error.message);
      }
    };
  });
}


// ----- Host a new trip, or edit one -----
async function pageHostForm({ page, id, put }) {
  const editing = page === 'edit';
  let trip = null;
  let city = cityById(state.cityId);

  if (editing) {
    const { data, error } = await db.from('trip_details').select('*').eq('trip_id', Number(id)).maybeSingle();
    if (error) throw error;
    if (!data || data.host_id !== state.user.id) {
      put(`<h1>You can't edit this trip</h1><p>Only the host can edit a trip. <a href="#/my">Go to my trips</a></p>`);
      return;
    }
    if (data.status === 'cancelled') {
      put(`<h1>This trip was cancelled</h1><p>Cancelled trips can't be edited. <a href="#/host">Host a new trip</a></p>`);
      return;
    }
    trip = data;
    city = cityById(data.city_id);
  }

  const { data: locations, error } = await db.from('locations')
    .select('id, name, address').eq('city_id', city.id).order('name');
  if (error) throw error;

  if (!locations.length) {
    put(`<h1>Host a trip</h1><div class="empty"><p>There are no fishing spots in ${esc(city.name)} yet, so trips can't be posted here.</p></div>`);
    return;
  }

  const today = todayStr();
  const minDate = trip && trip.trip_date < today ? trip.trip_date : today;
  const minSize = trip ? Math.max(1, trip.spots_taken) : 1;

  if (!put(`
    ${editing ? `<p class="back"><a href="#/trip/${trip.trip_id}">Back to trip</a></p>` : ''}
    <h1>${editing ? 'Edit trip' : `Host a trip in ${esc(city.name)}`}</h1>
    <p>${editing ? 'Everyone signed up will see your changes.' : 'Anyone in your city can find and join your trip.'}</p>

    <form id="trip-form" class="panel stack" novalidate>
      <label class="field">Fishing spot
        <select name="location_id" required>
          <option value="">Choose a spot</option>
          ${locations.map((l) => `
            <option value="${l.id}"${trip && trip.location_id === l.id ? ' selected' : ''}>${esc(l.name)}</option>`).join('')}
        </select>
        <span class="hint">Only verified public spots are listed. <a href="#/spots">See spot details</a></span>
      </label>

      <label class="field">Date
        <input type="date" name="trip_date" required min="${minDate}" value="${trip ? esc(trip.trip_date) : ''}">
      </label>

      <label class="field">Start time
        <input type="time" name="start_time" required value="${trip ? esc(trip.start_time.slice(0, 5)) : ''}">
      </label>

      <label class="field">Group size
        <input type="number" name="group_size" required min="${minSize}" max="50" value="${trip ? trip.group_size : 6}">
        <span class="hint">How many people can join, not counting you.${trip && trip.spots_taken ? ` ${trip.spots_taken} already signed up.` : ''}</span>
      </label>

      <div class="form-msg"></div>
      <div class="row">
        <button class="btn primary" type="submit">${editing ? 'Save changes' : 'Post trip'}</button>
        <a href="${editing ? `#/trip/${trip.trip_id}` : '#/trips'}">Cancel</a>
      </div>
    </form>`)) return;

  const form = document.getElementById('trip-form');
  const msg = form.querySelector('.form-msg');
  const button = form.querySelector('button[type="submit"]');

  form.onsubmit = async (event) => {
    event.preventDefault();
    const f = new FormData(form);
    const values = {
      location_id: Number(f.get('location_id')),
      trip_date: String(f.get('trip_date') || ''),
      start_time: String(f.get('start_time') || ''),
      group_size: Number(f.get('group_size')),
    };

    // Check the form before sending it
    if (!values.location_id) return (msg.innerHTML = errorBox('Choose a fishing spot.'));
    if (!values.trip_date) return (msg.innerHTML = errorBox('Choose a date.'));
    if (!editing && values.trip_date < today) return (msg.innerHTML = errorBox('Choose a date that is today or later.'));
    if (!values.start_time) return (msg.innerHTML = errorBox('Choose a start time.'));
    if (!Number.isInteger(values.group_size) || values.group_size < 1 || values.group_size > 50) {
      return (msg.innerHTML = errorBox('Group size must be a whole number from 1 to 50.'));
    }

    button.disabled = true;
    msg.innerHTML = '';

    if (editing) {
      const { error } = await db.from('trips').update(values).eq('id', trip.trip_id);
      button.disabled = false;
      if (error) return (msg.innerHTML = errorBox(error.message));
      go(`/trip/${trip.trip_id}`, 'Changes saved.');
    } else {
      const { data, error } = await db.from('trips')
        .insert({ ...values, host_id: state.user.id })
        .select('id')
        .single();
      button.disabled = false;
      if (error) return (msg.innerHTML = errorBox(error.message));
      go(`/trip/${data.id}`, 'Trip posted. Others in your city can now join.');
    }
  };
}


// ----- My trips: going and hosting -----
async function pageMyTrips({ put }) {
  const userId = state.user.id;

  const [mineRes, waitRes] = await Promise.all([
    db.from('rsvps').select('trip_id').eq('user_id', userId),
    db.from('waitlist').select('trip_id').eq('user_id', userId),
  ]);
  if (mineRes.error) throw mineRes.error;
  if (waitRes.error) throw waitRes.error;
  const goingIds = new Set(mineRes.data.map((r) => r.trip_id));
  const waitingIds = waitRes.data.map((r) => r.trip_id);

  const [goingRes, hostingRes, waitTripsRes] = await Promise.all([
    goingIds.size
      ? db.from('trip_details').select('*').in('trip_id', [...goingIds]).order('trip_date').order('start_time')
      : Promise.resolve({ data: [], error: null }),
    db.from('trip_details').select('*').eq('host_id', userId).order('trip_date').order('start_time'),
    waitingIds.length
      ? db.from('trip_details').select('*').in('trip_id', waitingIds).order('trip_date').order('start_time')
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (goingRes.error) throw goingRes.error;
  if (hostingRes.error) throw hostingRes.error;
  if (waitTripsRes.error) throw waitTripsRes.error;

  const today = todayStr();
  const upcoming = (list) => list.filter((t) => t.trip_date >= today);
  const past = [...goingRes.data, ...hostingRes.data]
    .filter((t) => t.trip_date < today)
    .sort((a, b) => (a.trip_date < b.trip_date ? 1 : -1));

  const list = (trips, emptyText) => trips.length
    ? `<ul class="trip-list">${trips.map((t) => tripRow(t, goingIds)).join('')}</ul>`
    : `<p class="empty-line">${emptyText}</p>`;

  const waitingUpcoming = upcoming(waitTripsRes.data).filter((t) => t.status === 'active');

  put(`
    <h1>My trips</h1>

    <h2>Going</h2>
    ${list(upcoming(goingRes.data), 'You haven\'t joined any upcoming trips. <a href="#/trips">Find a trip</a>')}

    ${waitingUpcoming.length ? `
      <h2>On the waitlist</h2>
      <p class="hint">You'll be given a spot automatically if one opens up, so check here before you set off.</p>
      ${list(waitingUpcoming, '')}` : ''}

    <h2>Hosting</h2>
    ${list(upcoming(hostingRes.data), 'You aren\'t hosting any upcoming trips. <a href="#/host">Host a trip</a>')}

    ${past.length ? `
      <details>
        <summary>Past trips (${past.length})</summary>
        ${list(past, '')}
      </details>` : ''}
  `);
}


// ----- FAQ, safety, and license links -----
async function pageFaq({ put }) {
  put(`
    <h1>FAQ and safety</h1>
    <p>New to fishing, or new to CastConnect? Here's what to expect.</p>

    <section class="faq">
      <h2>What happens on a trip?</h2>
      <p>A host meets the group at a public fishing spot at the listed time. Trips are relaxed and open to beginners, so it's fine if you've never fished before. Just say so, and the host or other members can show you the basics.</p>

      <h2>How do I check in?</h2>
      <p>When you arrive, find the host at the meeting place and tell them your display name. They'll mark you as arrived in the app. If you can't make it, leave the trip in the app so someone else can take your spot.</p>

      <h2>What should I bring?</h2>
      <ul>
        <li>Your fishing license, if your state requires one (see below)</li>
        <li>Water and a snack</li>
        <li>Sunscreen, a hat, and bug spray</li>
        <li>A charged phone</li>
        <li>A small bag for trash, so the spot stays clean</li>
        <li>Your own fishing gear, if you have it</li>
      </ul>

      <h2>What should I wear?</h2>
      <ul>
        <li>Layers, since it can be cooler by the water</li>
        <li>Closed-toe shoes with good grip, because banks and piers get slippery</li>
        <li>A rain jacket if rain is in the forecast</li>
        <li>Sunglasses, which also protect your eyes from swinging hooks</li>
      </ul>

      <h2>How does borrowing gear work?</h2>
      <p>When you join a trip, check "I need to borrow gear." The host and other members can see how many people need gear, and anyone with spares can bring them. Borrowed gear isn't guaranteed, and CastConnect doesn't lend, rent, or track equipment. Please return anything you borrow at the end of the trip.</p>

      <h2>Safety tips</h2>
      <ul>
        <li>Tell someone where you're going and when you expect to be back.</li>
        <li>Meet only at the listed public spot. You don't have to share your phone number or email with anyone.</li>
        <li>Stay back from steep banks, pier edges, and fast-moving water. Weak swimmers should wear a life jacket near deep water.</li>
        <li>Handle hooks and knives carefully, and look behind you before you cast.</li>
        <li>Check the weather. If you hear thunder, stop fishing and get off the water's edge, since fishing rods can conduct electricity.</li>
        <li>Children should be supervised by their own adult at all times.</li>
      </ul>

      <h2>If a trip is full</h2>
      <p>Join the waitlist. If someone drops out, or the host raises the group size, the next person waiting is given the spot automatically and the trip moves into the Going list on My trips. Nothing emails you, so check My trips before you set off. You can leave the waitlist any time.</p>

      <h2>If you can't make it</h2>
      <p>Leave the trip in the app so your spot goes to the next person. It takes one tap and costs you nothing.</p>
      <p>Please don't just not turn up. Hosts plan around the number of people signed up, and someone on the waitlist may have wanted your spot.</p>

      <h2>If a trip is cancelled</h2>
      <p>Cancelled trips disappear from the trip list. If you'd signed up, the trip shows as cancelled on your My trips page.</p>

      <h2>Hosting your first trip</h2>
      <p>Anyone with an account can host. You don't need to be an expert — most of hosting is turning up and being friendly.</p>
      <ol>
        <li><strong>Pick a spot.</strong> Open <a href="#/spots">Fishing spots</a> and choose one you've been to, or visit it once beforehand so you know where to meet and where to park.</li>
        <li><strong>Post the trip.</strong> Go to <a href="#/host">Host a trip</a> and set the location, date, start time and group size. Group size is how many people can join, not counting you. Four to six works well for a first trip.</li>
        <li><strong>Check the gear count.</strong> Your trip page shows how many people asked to borrow equipment. Bring spares if you have them, and mention it in the group so others can too.</li>
        <li><strong>Turn up early.</strong> Ten minutes ahead gives you time to find a spot where the group can stand together.</li>
        <li><strong>Check people in.</strong> As each person arrives, tick them off on your trip page. It takes seconds and it gives the trip an attendance record.</li>
        <li><strong>If plans change, cancel.</strong> Cancelling removes the trip from the listings and marks it clearly for everyone signed up. Do it as early as you can, because people drive to these.</li>
      </ol>
      <p>Hosts see attendees' display names, who needs gear, and nothing else. You never see anyone's email address or phone number, and they never see yours.</p>

      <h2>Privacy</h2>
      <p>Other members only see your display name. Your email address is never shown. Hosts see who signed up and who needs gear, so they can plan the trip.</p>

      <h2>Fishing licenses</h2>
      <p>Each state sets its own license rules, and most require adults to have a license. Check your state's rules before you fish:</p>
      ${state.cities.length
        ? `<ul>${state.cities.map((c) => `<li>${esc(c.name)}: ${licenseLink(c)}</li>`).join('')}</ul>`
        : '<p>License links will appear here once cities are added.</p>'}

      <h2>Something wrong?</h2>
      <p>If a location is described wrongly, a page misbehaves, or someone makes you uncomfortable, tell us: <a href="#/report">report a problem</a>. Reports go straight to the CastConnect team.</p>
    </section>
  `);
}


// ----- Report a problem -----
const REPORT_CATEGORIES = [
  'Something is broken',
  'Wrong information about a location',
  'A problem with a trip or a person',
  'Something else',
];

async function pageReport({ put }) {
  const { data: past, error } = await db.from('reports')
    .select('id, category, details, status, created_at')
    .order('created_at', { ascending: false });
  if (error) throw error;

  if (!put(`
    <h1>Report a problem</h1>
    <p>Tell us what went wrong and we'll look into it. If someone is in danger, call emergency services first.</p>

    <form id="report-form" class="panel stack" novalidate>
      <label class="field">What kind of problem?
        <select name="category" required>
          <option value="">Choose one</option>
          ${REPORT_CATEGORIES.map((c) => `<option value="${esc(c)}">${esc(c)}</option>`).join('')}
        </select>
      </label>

      <label class="field">What happened?
        <textarea name="details" rows="5" required minlength="10" maxlength="2000"></textarea>
        <span class="hint">Include the trip or fishing spot if it's about one. At least 10 characters.</span>
      </label>

      <div class="form-msg"></div>
      <button class="btn primary" type="submit">Send report</button>
      <p class="hint">Your display name is attached so we can reply through the team. Nothing you write here is shown to other members.</p>
    </form>

    ${past.length ? `
      <h2>Reports you've sent</h2>
      <ul class="spot-list">
        ${past.map((r) => `
          <li>
            <h3>${esc(r.category)} <span class="tag${r.status === 'closed' ? '' : ' gear'}">${r.status === 'closed' ? 'Closed' : 'Open'}</span></h3>
            <p>${esc(r.details)}</p>
            <p class="hint">Sent ${esc(formatDate(r.created_at.slice(0, 10)))}</p>
          </li>`).join('')}
      </ul>` : ''}
  `)) return;

  const form = document.getElementById('report-form');
  const msg = form.querySelector('.form-msg');
  const button = form.querySelector('button[type="submit"]');

  form.onsubmit = async (event) => {
    event.preventDefault();
    const f = new FormData(form);
    const category = String(f.get('category') || '');
    const details = String(f.get('details') || '').trim();

    if (!category) return (msg.innerHTML = errorBox('Choose what kind of problem it is.'));
    if (details.length < 10) return (msg.innerHTML = errorBox('Add a little more detail, at least 10 characters.'));

    button.disabled = true;
    msg.innerHTML = '';

    const { error: insertError } = await db.from('reports').insert({
      user_id: state.user.id,
      category,
      details,
      about_page: location.hash || '#/report',
    });
    button.disabled = false;
    if (insertError) return (msg.innerHTML = errorBox(insertError.message));

    go('/report', 'Report sent. Thanks — the team will take a look.');
  };
}


// ---------------------------------------------------------------------
// START
// ---------------------------------------------------------------------

if (!db) {
  app.innerHTML = configMissing
    ? `<h1>Almost there</h1>
       <p>Open <strong>config.js</strong> and paste in your Supabase project URL and publishable key, then reload this page.</p>`
    : `<h1>Can't load the app</h1>
       <p>The Supabase library didn't load. Check your internet connection and reload the page.</p>`;
} else {
  window.addEventListener('hashchange', render);
  startApp();
}

// After someone clicks the confirmation link in their email, Supabase sends them
// back here with the login tokens stuck on the end of the address, like
// "#access_token=...&type=signup". Those tokens have to be collected BEFORE the
// router runs, because the router would otherwise replace the address with
// "#/login" and throw the tokens away. That is what makes a confirmation link
// look broken even when it worked.
async function startApp() {
  await consumeAuthRedirect();
  render();
}

async function consumeAuthRedirect() {
  const raw = location.hash.replace(/^#/, '');
  const code = new URLSearchParams(location.search).get('code');

  // Our own pages always start with "/", so anything else with an "=" in it
  // came from Supabase.
  const authHash = raw && !raw.startsWith('/') && raw.includes('=');
  if (!authHash && !code) return;

  const clean = () => history.replaceState(null, '', location.pathname + '#/trips');

  if (code) {
    const { error } = await db.auth.exchangeCodeForSession(code);
    clean();
    state.notice = error
      ? `That confirmation link couldn't be used: ${error.message} Try logging in and sending a new one.`
      : "Email confirmed. You're logged in.";
    return;
  }

  const params = new URLSearchParams(raw);
  const failed = params.get('error_description') || params.get('error');
  if (failed) {
    clean();
    state.notice = `That confirmation link didn't work: ${failed}. Log in below and we'll send a new one.`;
    return;
  }

  // The Supabase library reads the tokens out of the address on its own, but
  // not instantly. Wait for it, up to two seconds.
  for (let i = 0; i < 40; i++) {
    const { data: { session } } = await db.auth.getSession();
    if (session) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  clean();
  state.notice = "Email confirmed. You're logged in.";
}
