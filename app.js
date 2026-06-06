'use strict';

/* ============================================================
   Marine Weather — Long Island Sound
   Static client-side app. Free, key-less, CORS-friendly APIs:
   - NWS api.weather.gov  (forecast text + active alerts)
   - Open-Meteo           (wind/gust/visibility/temp + hourly)
   - Open-Meteo Marine    (wave height/period + water temp)
   - NOAA Tides&Currents  (high/low tides + The Race/Plum Gut currents)
   ============================================================ */

const NWS_UA = 'marine-weather (henry@sztul.com)'; // NWS asks for an identifying UA

// Boating areas. Each preset drives the top-of-page conditions, NWS marine
// zone, nearest tide station, and nearest predicting tidal-current station.
// Mamaroneck (home port) is the default.
const LOCATIONS = [
  { id: 'mamaroneck', name: 'Mamaroneck',       lat: 40.948, lon: -73.732, zone: 'ANZ335', tide: '8518091', tideName: 'Rye Beach',  current: 'ACT3201', currentName: 'Off Mamaroneck',  obs: '8516945', obsName: 'Kings Point' },
  { id: 'central',    name: 'Central LI Sound', lat: 41.10,  lon: -73.10,  zone: 'ANZ335', tide: '8467150', tideName: 'Bridgeport', current: 'LIS1027', currentName: 'Stratford Shoal', obs: '8467150', obsName: 'Bridgeport' },
  { id: 'east',       name: 'Eastern LI Sound', lat: 41.18,  lon: -72.55,  zone: 'ANZ332', tide: '8461490', tideName: 'New London', current: 'LIS1001', currentName: 'The Race',       obs: '8461490', obsName: 'New London' },
];

// Small Craft Advisory-style thresholds (NWS marine criteria)
const TH = {
  windRed: 25, gustRed: 25, waveRed: 5, visRedNm: 1,   // no-go
  windYel: 20, gustYel: 18, waveYel: 3, visYelNm: 3,   // caution
};

let state = {
  loc: LOCATIONS[0],
  data: null,
  forecastZones: [],
};

/* ---------------- small helpers ---------------- */
const $ = (id) => document.getElementById(id);
const fmtTime = (d) => d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const compass = (deg) => ['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW']
  [Math.round(((deg % 360) / 22.5)) % 16];
const cToF = (c) => (c == null ? null : c * 9 / 5 + 32);
const mToNm = (m) => (m == null ? null : m / 1852);
const round = (n, d = 0) => (n == null || isNaN(n) ? null : Number(n.toFixed(d)));

async function getJSON(url, opts = {}) {
  const res = await fetch(url, opts);
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.json();
}

/* ---------------- data fetching ---------------- */
async function fetchOpenMeteo(loc) {
  const base = 'https://api.open-meteo.com/v1/forecast?latitude=' + loc.lat + '&longitude=' + loc.lon +
    '&current=wind_speed_10m,wind_gusts_10m,wind_direction_10m,temperature_2m,visibility,weather_code' +
    '&hourly=wind_speed_10m,wind_gusts_10m,wind_direction_10m,visibility,precipitation_probability,weather_code,temperature_2m,cloud_cover,surface_pressure' +
    '&wind_speed_unit=kn&temperature_unit=fahrenheit&timezone=America%2FNew_York&forecast_days=3';
  return getJSON(base);
}

async function fetchMarine(loc) {
  const url = 'https://marine-api.open-meteo.com/v1/marine?latitude=' + loc.lat + '&longitude=' + loc.lon +
    '&current=wave_height,wave_period,wave_direction,sea_surface_temperature' +
    '&hourly=wave_height,wave_period' +
    '&length_unit=imperial&timezone=America%2FNew_York&forecast_days=3';
  return getJSON(url).catch(() => null); // marine model can be sparse; degrade gracefully
}

async function fetchTides(loc) {
  const today = ymd(new Date());
  const url = 'https://api.tidesandcurrents.noaa.gov/api/prod/datagetter?product=predictions&datum=MLLW' +
    '&station=' + loc.tide + '&time_zone=lst_ldt&units=english&interval=hilo&format=json' +
    '&begin_date=' + today + '&range=48';
  return getJSON(url).then((d) => d.predictions || []).catch(() => []);
}

async function fetchCurrent(station) {
  const today = ymd(new Date());
  const url = 'https://api.tidesandcurrents.noaa.gov/api/prod/datagetter?product=currents_predictions' +
    '&station=' + station + '&time_zone=lst_ldt&units=english&interval=MAX_SLACK&format=json' +
    '&begin_date=' + today + '&range=30';
  return getJSON(url).then((d) => (d.current_predictions && d.current_predictions.cp) || []).catch(() => []);
}

// Observed conditions from a NOAA CO-OPS met station (reliable, CORS-friendly,
// permanent — used instead of the seasonal NDBC LIS buoys which go offline).
async function fetchObs(station) {
  if (!station) return null;
  const co = (product) => 'https://api.tidesandcurrents.noaa.gov/api/prod/datagetter?product=' + product +
    '&station=' + station + '&time_zone=lst_ldt&units=english&format=json&date=latest';
  const [water, wind] = await Promise.all([
    getJSON(co('water_temperature')).catch(() => null),
    getJSON(co('wind')).catch(() => null),
  ]);
  const wd = water && water.data && water.data[0];
  const nd = wind && wind.data && wind.data[0];
  return {
    waterF: wd ? parseFloat(wd.v) : null,
    waterTime: wd ? wd.t : null,
    obsWind: nd ? parseFloat(nd.s) : null,
    obsGust: nd ? parseFloat(nd.g) : null,
    obsWindDir: nd ? parseFloat(nd.d) : null,
  };
}

async function fetchAlerts(zone) {
  return getJSON('https://api.weather.gov/alerts/active?zone=' + zone, { headers: { 'User-Agent': NWS_UA } })
    .then((d) => (d.features || []).map((f) => f.properties))
    .catch(() => []);
}

async function fetchCwfText() {
  const list = await getJSON('https://api.weather.gov/products?type=CWF&location=OKX', { headers: { 'User-Agent': NWS_UA } });
  const latest = (list['@graph'] || [])[0];
  if (!latest) throw new Error('No CWF product available');
  const prod = await getJSON(latest['@id'], { headers: { 'User-Agent': NWS_UA } });
  return prod.productText || '';
}

function ymd(d) {
  return d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0');
}
// NOAA returns "YYYY-MM-DD HH:MM" in local station time; parse as local clock time
function parseNoaa(t) { return new Date(t.replace(' ', 'T')); }

/* ---------------- go / no-go engine ---------------- */
function computeVerdict(d) {
  const reasons = [];
  let level = 0; // 0 go, 1 caution, 2 no-go

  const wind = d.wind, gust = d.gust, wave = d.wave, visNm = d.visNm, code = d.weatherCode;

  const bump = (lvl, txt) => { level = Math.max(level, lvl); reasons.push({ lvl, txt }); };

  if (gust != null) {
    if (gust >= TH.gustRed) bump(2, `Gusts ${round(gust)} kt`);
    else if (gust >= TH.gustYel) bump(1, `Gusts ${round(gust)} kt`);
  }
  if (wind != null) {
    if (wind >= TH.windRed) bump(2, `Wind ${round(wind)} kt`);
    else if (wind >= TH.windYel) bump(1, `Wind ${round(wind)} kt`);
  }
  if (wave != null) {
    if (wave >= TH.waveRed) bump(2, `Seas ${round(wave, 1)} ft`);
    else if (wave >= TH.waveYel) bump(1, `Seas ${round(wave, 1)} ft`);
  }
  if (visNm != null) {
    if (visNm < TH.visRedNm) bump(2, `Vis ${round(visNm, 1)} nm (fog)`);
    else if (visNm < TH.visYelNm) bump(1, `Vis ${round(visNm, 1)} nm`);
  }
  if ([95, 96, 99].includes(code)) bump(2, 'Thunderstorms');
  if (d.activeWarning) bump(2, d.activeWarning);

  return { level, reasons };
}

/* ---------------- rendering ---------------- */
const VERDICT_STYLES = [
  { bg: 'bg-emerald-600', label: 'GO', emoji: '⛵️', sub: 'Conditions within small-craft limits' },
  { bg: 'bg-amber-500',   label: 'CAUTION', emoji: '⚠️', sub: 'Marginal — watch conditions closely' },
  { bg: 'bg-red-600',     label: 'NO-GO', emoji: '🛑', sub: 'Small-craft conditions or worse' },
];

function renderVerdict(v) {
  const s = VERDICT_STYLES[v.level];
  const el = $('verdict');
  el.className = 'rounded-2xl p-5 mb-3 text-white shadow-sm transition-colors ' + s.bg;
  $('verdict-label').textContent = s.label;
  $('verdict-sub').textContent = s.sub;
  $('verdict-emoji').textContent = s.emoji;
  const chips = v.reasons.length
    ? v.reasons.map((r) => `<span class="text-xs font-medium bg-white/20 rounded-full px-2 py-0.5">${r.txt}</span>`).join('')
    : `<span class="text-xs font-medium bg-white/20 rounded-full px-2 py-0.5">All clear</span>`;
  $('verdict-reasons').innerHTML = chips;
}

function statCard(label, value, unit, sub) {
  return `<div class="rounded-2xl bg-white dark:bg-slate-800 shadow-sm ring-1 ring-black/5 dark:ring-white/10 p-3">
    <div class="text-[11px] uppercase tracking-wide text-slate-400 font-semibold">${label}</div>
    <div class="mt-0.5 text-2xl font-bold leading-none">${value ?? '—'}<span class="text-sm font-medium text-slate-400 ml-1">${value != null ? unit : ''}</span></div>
    ${sub ? `<div class="text-xs text-slate-500 dark:text-slate-400 mt-1">${sub}</div>` : ''}
  </div>`;
}

function renderNow(d) {
  const arrow = d.windDir != null
    ? `<span class="inline-block" style="transform:rotate(${d.windDir + 180}deg)">↑</span> ${compass(d.windDir)}`
    : '';
  $('now-grid').innerHTML = [
    statCard('Wind', round(d.wind), 'kt', d.gust != null ? `Gusts ${round(d.gust)} kt` : ''),
    statCard('Direction', d.windDir != null ? compass(d.windDir) : '—', '', `from ${d.windDir ?? '—'}°`),
    statCard('Seas', round(d.wave, 1), 'ft', d.wavePeriod ? `${round(d.wavePeriod, 1)} s period` : 'no model data'),
    statCard('Visibility', d.visNm != null ? round(d.visNm, 1) : '—', 'nm', d.visNm != null && d.visNm < 3 ? 'reduced' : 'clear'),
    statCard('Water', round(d.waterF), '°F', d.waterSrc ? (d.waterSrc === 'model' ? 'model est.' : 'obs · ' + d.waterSrc) : ''),
    statCard('Air', round(d.airF), '°F', ''),
  ].join('');
}

function renderAlerts(alerts) {
  const wrap = $('alerts');
  if (!alerts.length) { wrap.innerHTML = ''; return; }

  const isWarn = (a) => /warning/i.test(a.event);
  const hasWarning = alerts.some(isWarn);
  const color = hasWarning ? 'bg-red-600' : 'bg-amber-500';
  const top = alerts.find(isWarn) || alerts[0];
  const n = alerts.length;

  const items = alerts.map((a) => {
    const edge = isWarn(a) ? 'border-red-500' : 'border-amber-400';
    const desc = (a.description || '').trim().replace(/\n{3,}/g, '\n\n').replace(/\n/g, '<br>');
    return `<div class="rounded-xl bg-white dark:bg-slate-800 ring-1 ring-black/5 dark:ring-white/10 border-l-4 ${edge} px-3 py-2">
      <div class="font-bold text-sm">${a.event}</div>
      <div class="text-xs text-slate-500 dark:text-slate-400 mt-0.5">${(a.headline || '').replace(/\s+/g, ' ')}</div>
      ${desc ? `<div class="text-xs text-slate-600 dark:text-slate-300 mt-1.5 leading-relaxed">${desc}</div>` : ''}
    </div>`;
  }).join('');

  wrap.innerHTML = `
    <button id="alerts-toggle" class="w-full ${color} text-white rounded-2xl px-4 py-3 shadow-sm flex items-center gap-3 active:scale-[0.99] transition">
      <span class="flex items-center gap-2 font-bold text-sm min-w-0 flex-1">
        <span class="shrink-0">⚠ ${n} active ${n === 1 ? 'alert' : 'alerts'}</span>
        <span class="font-normal opacity-90 truncate">· ${top.event}</span>
      </span>
      <svg id="alerts-chevron" viewBox="0 0 24 24" class="h-5 w-5 shrink-0 transition-transform" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9l6 6 6-6"/></svg>
    </button>
    <div id="alerts-detail" class="hidden space-y-2 mt-2">${items}</div>`;

  $('alerts-toggle').addEventListener('click', () => {
    const nowHidden = $('alerts-detail').classList.toggle('hidden');
    $('alerts-chevron').style.transform = nowHidden ? '' : 'rotate(180deg)';
  });
}

function renderTides(preds, loc) {
  const now = new Date();
  const upcoming = preds.map((p) => ({ when: parseNoaa(p.t), type: p.type, v: parseFloat(p.v) }))
    .filter((p) => p.when > now).slice(0, 4);
  const rows = upcoming.map((p) => `
    <div class="flex items-center justify-between py-1">
      <span class="text-sm">${p.type === 'H' ? '🔺 High' : '🔻 Low'}</span>
      <span class="text-sm font-medium">${fmtTime(p.when)}</span>
      <span class="text-xs text-slate-400">${p.v.toFixed(1)} ft</span>
    </div>`).join('') || '<div class="text-sm text-slate-400">Tide data unavailable</div>';
  $('tides-card').innerHTML = `
    <div class="text-[11px] uppercase tracking-wide text-slate-400 font-semibold mb-1">Tides · ${loc.tideName}</div>
    ${rows}`;
}

function renderCurrents(cp, loc) {
  const card = $('currents-card');
  const now = new Date();
  const next = (cp || []).map((c) => ({ when: parseNoaa(c.Time), type: c.Type, vel: c.Velocity_Major }))
    .filter((c) => c.when > now).slice(0, 4);
  if (!next.length) { card.classList.add('hidden'); return; } // no local prediction → hide entirely
  card.classList.remove('hidden');
  const items = next.map((c) => {
    const label = c.type === 'slack' ? 'Slack water'
      : c.type === 'flood' ? `Flood ${Math.abs(c.vel).toFixed(1)} kt`
      : `Ebb ${Math.abs(c.vel).toFixed(1)} kt`;
    // In western LIS, flood sets W/SW, ebb sets E/NE
    const dir = c.type === 'flood' ? 'sets W' : c.type === 'ebb' ? 'sets E' : '';
    return `<div class="flex items-center justify-between py-1">
      <span class="text-sm">${label} <span class="text-slate-400 text-xs">${dir}</span></span>
      <span class="text-sm font-medium">${fmtTime(c.when)}</span></div>`;
  }).join('');
  card.innerHTML = `
    <div class="text-[11px] uppercase tracking-wide text-slate-400 font-semibold mb-1">Tidal Current · ${loc.currentName || 'Local'}</div>
    ${items}`;
}

function renderSun(loc) {
  const today = new Date();
  // anchor to local noon so we always get today's sun (sunTimes snaps to the
  // nearest solar noon, which returns yesterday's times in the early morning)
  const { sunrise, sunset } = sunTimes(new Date(today.getFullYear(), today.getMonth(), today.getDate(), 12), loc.lat, loc.lon);
  const now = today.getTime();
  const daylight = (sunset - sunrise) / 3600000;
  const remaining = sunset > now ? (sunset - now) / 3600000 : 0;
  $('sun-card').innerHTML = `
    <div class="text-[11px] uppercase tracking-wide text-slate-400 font-semibold mb-1">Daylight</div>
    <div class="flex items-center justify-between py-1"><span class="text-sm">🌅 Sunrise</span><span class="text-sm font-medium">${fmtTime(new Date(sunrise))}</span></div>
    <div class="flex items-center justify-between py-1"><span class="text-sm">🌇 Sunset</span><span class="text-sm font-medium">${fmtTime(new Date(sunset))}</span></div>
    <div class="text-xs text-slate-400 mt-1">${daylight.toFixed(1)} h of daylight${remaining > 0 ? ` · ${remaining.toFixed(1)} h left` : ' · after sunset'}</div>`;
}

/* ---------------- 48h hourly strip ---------------- */
function renderHourly(om, marine, fishing) {
  const fScore = (fishing && fishing.scoreByMs) || {};
  const h = om.hourly;
  if (!h) { $('hourly-content').innerHTML = '<div class="text-slate-400 text-sm">Hourly data unavailable</div>'; return; }
  const waveByTime = {};
  if (marine && marine.hourly) marine.hourly.time.forEach((t, i) => { waveByTime[t] = marine.hourly.wave_height[i]; });

  const now = Date.now();
  const idx = h.time.map((t, i) => ({ t: new Date(t).getTime(), i }))
    .filter((o) => o.t >= now - 3600000).slice(0, 48).filter((_, i) => i % 3 === 0); // every 3h, 48h out

  const maxGust = Math.max(20, ...idx.map((o) => h.wind_gusts_10m[o.i] || 0));
  const rows = idx.map((o) => {
    const i = o.i;
    const time = new Date(h.time[i]);
    const gust = h.wind_gusts_10m[i];
    const wind = h.wind_speed_10m[i];
    const wave = waveByTime[h.time[i]];
    const pop = h.precipitation_probability[i];
    const dir = h.wind_direction_10m[i];
    const barPct = Math.min(100, (gust / maxGust) * 100);
    const barColor = gust >= TH.gustRed ? 'bg-red-500' : gust >= TH.gustYel ? 'bg-amber-400' : 'bg-emerald-500';
    const hr = time.toLocaleTimeString([], { weekday: 'short', hour: 'numeric' });
    const fs = fScore[o.t];
    const accent = fs == null ? 'border-transparent' : fs >= 64 ? 'border-emerald-400' : fs >= 52 ? 'border-amber-400' : 'border-transparent';
    return `<div class="flex items-center gap-1.5 py-1.5 pl-1.5 border-l-2 ${accent} border-b border-b-black/5 dark:border-b-white/5 last:border-b-0">
      <div class="w-16 shrink-0 text-xs text-slate-500">${hr}</div>
      <div class="w-12 shrink-0 text-xs"><span style="display:inline-block;transform:rotate(${dir + 180}deg)">↑</span> ${compass(dir)}</div>
      <div class="flex-1 min-w-0">
        <div class="h-2 rounded-full bg-slate-200 dark:bg-slate-700 overflow-hidden"><div class="h-full ${barColor}" style="width:${barPct}%"></div></div>
      </div>
      <div class="w-16 shrink-0 text-right text-xs font-medium">${round(wind)}<span class="text-slate-400">/${round(gust)}</span></div>
      <div class="w-10 shrink-0 text-right text-xs ${wave >= TH.waveYel ? 'text-amber-500 font-medium' : 'text-slate-500'}">${wave != null ? round(wave, 1) : '—'}</div>
      <div class="w-9 shrink-0 text-right text-xs ${pop >= 50 ? 'text-blue-500 font-medium' : 'text-slate-400'}">${pop ?? 0}%</div>
    </div>`;
  }).join('');

  $('hourly-content').innerHTML = `
    <div class="flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-slate-400 font-semibold pb-1 border-b border-black/10 dark:border-white/10">
      <div class="w-16 shrink-0">Time</div><div class="w-12 shrink-0">Wind</div>
      <div class="flex-1 min-w-0">Gust</div><div class="w-16 text-right">kt</div>
      <div class="w-10 text-right">ft</div><div class="w-9 text-right">rain</div>
    </div>${rows}
    <div class="text-[10px] text-slate-400 mt-2 flex items-center gap-3">
      <span class="flex items-center gap-1"><span class="inline-block w-2 h-3 rounded-sm bg-emerald-400"></span>prime</span>
      <span class="flex items-center gap-1"><span class="inline-block w-2 h-3 rounded-sm bg-amber-400"></span>good fishing hour</span>
    </div>`;
}

/* ---------------- NWS marine text forecast ---------------- */
function parseForecast(content) {
  return content.split('$$').map(parseZone).filter(Boolean);
}
function parseZone(zoneContent) {
  const lines = zoneContent.trim().split('\n');
  const zoneRegex = /^ANZ\d{3}-\d{6}-$/;
  if (lines.length < 3 || !zoneRegex.test(lines[0])) return null;
  const zone = { id: lines[0].trim().slice(0, 6), name: lines[1].trim(), updateTime: lines[2].trim(), advisory: '', forecast: [] };
  // Skip the area-wide synopsis block (its "name" is a timestamp, not a zone name)
  if (/EDT|EST|AM|PM/.test(zone.name) && zone.name.length < 30) return null;
  let currentDay = '', forecastText = '';
  for (let i = 3; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.startsWith('...')) { zone.advisory = line.replace(/\./g, '').trim(); }
    else if (line.startsWith('.')) {
      if (currentDay) { zone.forecast.push({ day: currentDay, details: forecastText.trim() }); forecastText = ''; }
      currentDay = line.split('...')[0].replace('.', '').trim();
      forecastText = line.split('...')[1] ? line.split('...')[1].trim() + ' ' : '';
    } else if (currentDay) { forecastText += line + ' '; }
  }
  if (currentDay) zone.forecast.push({ day: currentDay, details: forecastText.trim() });
  return zone;
}
function renderZoneNav(zones) {
  const nav = $('zone-nav');
  const def = Math.max(0, zones.findIndex((z) => z.id === state.loc.zone));
  nav.innerHTML = `<select id="zone-select" class="w-full p-2 rounded-xl bg-white dark:bg-slate-800 ring-1 ring-black/10 dark:ring-white/10 focus:outline-none focus:ring-2 focus:ring-blue-500">
    ${zones.map((z, i) => `<option value="${i}" ${i === def ? 'selected' : ''}>${z.name}</option>`).join('')}</select>`;
  $('zone-select').addEventListener('change', (e) => showZone(parseInt(e.target.value, 10)));
  showZone(def);
}
function showZone(i) {
  const z = state.forecastZones[i];
  if (!z) return;
  $('zone-forecast').innerHTML = `
    <h2 class="text-lg font-bold">${z.name}</h2>
    <p class="text-xs text-slate-400 mb-2">${z.updateTime}</p>
    ${z.advisory ? `<p class="text-sm font-semibold text-red-500 mb-3">⚠ ${z.advisory}</p>` : ''}
    ${z.forecast.map((d) => `<div class="mb-3">
      <h3 class="text-sm font-bold uppercase tracking-wide text-slate-500">${d.day}</h3>
      <p class="text-sm mt-0.5 leading-relaxed">${d.details}</p></div>`).join('')}`;
}

/* ---------------- sun math (NOAA approximation) ---------------- */
function sunTimes(date, lat, lon) {
  const rad = Math.PI / 180;
  const dayMs = 86400000;
  const J1970 = 2440588, J2000 = 2451545;
  const toJulian = (d) => d.valueOf() / dayMs - 0.5 + J1970;
  const days = toJulian(date) - J2000;
  const M = rad * (357.5291 + 0.98560028 * days);
  const C = rad * (1.9148 * Math.sin(M) + 0.02 * Math.sin(2 * M) + 0.0003 * Math.sin(3 * M));
  const P = rad * 102.9372;
  const L = M + C + P + Math.PI;
  const dec = Math.asin(Math.sin(L) * Math.sin(rad * 23.4397));
  const lw = rad * -lon;
  const n = Math.round(days - 0.0009 - lw / (2 * Math.PI));
  const ds = 0.0009 + lw / (2 * Math.PI) + n;
  const Mn = rad * (357.5291 + 0.98560028 * (ds));
  const Cn = rad * (1.9148 * Math.sin(Mn) + 0.02 * Math.sin(2 * Mn) + 0.0003 * Math.sin(3 * Mn));
  const Ln = Mn + Cn + P + Math.PI;
  const transit = J2000 + ds + 0.0053 * Math.sin(Mn) - 0.0069 * Math.sin(2 * Ln);
  const h0 = rad * -0.833;
  const w0 = Math.acos((Math.sin(h0) - Math.sin(rad * lat) * Math.sin(dec)) / (Math.cos(rad * lat) * Math.cos(dec)));
  const Jset = transit + w0 / (2 * Math.PI);
  const Jrise = transit - w0 / (2 * Math.PI);
  const fromJulian = (j) => (j + 0.5 - J1970) * dayMs;
  return { sunrise: fromJulian(Jrise), sunset: fromJulian(Jset) };
}

/* ---------------- moon position (compact, SunCalc-derived, MIT) ---------------- */
const M_RAD = Math.PI / 180, M_DAYMS = 86400000, M_J1970 = 2440588, M_J2000 = 2451545, M_E = M_RAD * 23.4397;
const mToDays = (date) => date.valueOf() / M_DAYMS - 0.5 + M_J1970 - M_J2000;
const mRA = (l, b) => Math.atan2(Math.sin(l) * Math.cos(M_E) - Math.tan(b) * Math.sin(M_E), Math.cos(l));
const mDec = (l, b) => Math.asin(Math.sin(b) * Math.cos(M_E) + Math.cos(b) * Math.sin(M_E) * Math.sin(l));
const mSidereal = (d, lw) => M_RAD * (280.16 + 360.9856235 * d) - lw;
function mMoonCoords(d) {
  const L = M_RAD * (218.316 + 13.176396 * d), Ma = M_RAD * (134.963 + 13.064993 * d), F = M_RAD * (93.272 + 13.229350 * d);
  const l = L + M_RAD * 6.289 * Math.sin(Ma), b = M_RAD * 5.128 * Math.sin(F);
  return { ra: mRA(l, b), dec: mDec(l, b) };
}
function moonAlt(date, lat, lon) { // radians above horizon
  const lw = M_RAD * -lon, phi = M_RAD * lat, d = mToDays(date), c = mMoonCoords(d), H = mSidereal(d, lw) - c.ra;
  return Math.asin(Math.sin(phi) * Math.sin(c.dec) + Math.cos(phi) * Math.cos(c.dec) * Math.cos(H));
}
function mSunCoords(d) {
  const Ms = M_RAD * (357.5291 + 0.98560028 * d);
  const C = M_RAD * (1.9148 * Math.sin(Ms) + 0.02 * Math.sin(2 * Ms) + 0.0003 * Math.sin(3 * Ms));
  const L = Ms + C + M_RAD * 102.9372 + Math.PI;
  return { ra: mRA(L, 0), dec: mDec(L, 0) };
}
function moonIllum(date) { // illuminated fraction 0(new)..1(full)
  const d = mToDays(date), s = mSunCoords(d), m = mMoonCoords(d);
  const elong = Math.acos(Math.sin(s.dec) * Math.sin(m.dec) + Math.cos(s.dec) * Math.cos(m.dec) * Math.cos(s.ra - m.ra));
  return (1 - Math.cos(elong)) / 2;
}
function moonPhaseName() {
  const f = moonIllum(new Date()), f2 = moonIllum(new Date(Date.now() + M_DAYMS)), waxing = f2 > f;
  if (f < 0.04) return '🌑 New moon';
  if (f > 0.96) return '🌕 Full moon';
  if (Math.abs(f - 0.5) < 0.06) return waxing ? '🌓 First quarter' : '🌗 Last quarter';
  const cresc = f < 0.5;
  if (waxing) return cresc ? '🌒 Waxing crescent' : '🌔 Waxing gibbous';
  return cresc ? '🌘 Waning crescent' : '🌖 Waning gibbous';
}
// Solunar events: major = lunar transit/anti-transit (altitude extrema),
// minor = moonrise/set (altitude horizon crossings), scanned over the window.
function solunarEvents(startMs, hours, lat, lon) {
  const step = 1800000, N = Math.ceil(hours * 3600000 / step) + 2, alt = [];
  for (let k = -1; k <= N; k++) { const t = startMs + k * step; alt.push({ t, a: moonAlt(new Date(t), lat, lon) }); }
  const majors = [], minors = [];
  for (let k = 1; k < alt.length - 1; k++) {
    const p = alt[k - 1].a, c = alt[k].a, n = alt[k + 1].a;
    if ((c - p) * (n - c) < 0) majors.push(alt[k].t);
    if (p * c < 0) minors.push((alt[k - 1].t + alt[k].t) / 2);
  }
  return { majors, minors };
}

/* ---------------- fishing forecast ---------------- */
// Triangular window: 1 at center, linear to 0 at center-before / center+after.
function triWin(ms, center, before, after) {
  if (ms < center) { const dd = center - ms; return dd <= before ? 1 - dd / before : 0; }
  const dd = ms - center; return dd <= after ? 1 - dd / after : 0;
}
function nearestWin(ms, events, half) {
  let best = Infinity;
  for (const e of events) best = Math.min(best, Math.abs(ms - e));
  return best <= half ? 1 - best / half : 0;
}
function windScore(kt) { // fishable-chop sweet spot ~5-12kt
  if (kt == null) return 0.5;
  if (kt >= 22) return 0;
  if (kt >= 12) return 1 - (kt - 12) * (0.9 / 10);     // 12->1.0 .. 22->~0.1
  if (kt >= 5) return 1;                                // 5-12 prime
  return 0.6 + (kt / 5) * 0.4;                          // calm dip 0-5 -> 0.6..1.0
}

function computeFishing(om, tides, currentCp, loc) {
  if (!om || !om.hourly) return null;
  const H = om.hourly, lat = loc.lat, lon = loc.lon, now = Date.now();
  const hours = H.time.map((t, i) => ({ t: new Date(t).getTime(), i }))
    .filter((o) => o.t >= now - 3600000 && o.t <= now + 48 * 3600000);
  if (!hours.length) return null;
  const startMs = hours[0].t;

  // sun times cached per calendar day — anchor to LOCAL NOON so sunTimes
  // resolves the correct solar day (it otherwise snaps to the nearest noon,
  // returning the previous day's sun for after-midnight hours).
  const sunCache = {};
  const sun = (ms) => {
    const dt = new Date(ms), k = dt.toDateString();
    if (!sunCache[k]) sunCache[k] = sunTimes(new Date(dt.getFullYear(), dt.getMonth(), dt.getDate(), 12), lat, lon);
    return sunCache[k];
  };

  // tide turns (high/low)
  const turns = (tides || []).map((p) => parseNoaa(p.t).getTime());
  // current speed model: interpolate |velocity| between slack (~0) and max flood/ebb
  const cur = (currentCp || []).map((c) => ({ t: parseNoaa(c.Time).getTime(), vel: Math.abs(c.Velocity_Major || 0) })).sort((a, b) => a.t - b.t);
  const maxVel = Math.max(0.3, ...cur.map((c) => c.vel));
  function currentSpeed(ms) {
    if (cur.length < 2) return 0.5;
    if (ms <= cur[0].t) return cur[0].vel / maxVel;
    if (ms >= cur[cur.length - 1].t) return cur[cur.length - 1].vel / maxVel;
    for (let k = 0; k < cur.length - 1; k++) if (ms >= cur[k].t && ms <= cur[k + 1].t) {
      const f = (ms - cur[k].t) / (cur[k + 1].t - cur[k].t);
      return (cur[k].vel + f * (cur[k + 1].vel - cur[k].vel)) / maxVel;
    }
    return 0.5;
  }
  const turnBonus = (ms) => { let b = Infinity; for (const t of turns) b = Math.min(b, Math.abs(ms - t)); const w = 90 * 60000; return b <= w ? 1 - b / w : 0; };

  const ev = solunarEvents(startMs, 48, lat, lon);
  const illum = moonIllum(new Date(now));
  const phaseFactor = 0.7 + 0.3 * Math.cos(2 * Math.PI * illum); // new & full boost; quarters lower

  const data = hours.map((o) => {
    const ms = o.t, i = o.i, s = sun(ms);
    const isDay = ms > s.sunrise && ms < s.sunset;
    const dawn = triWin(ms, s.sunrise, 60 * 60000, 90 * 60000);
    const dusk = triWin(ms, s.sunset, 90 * 60000, 60 * 60000);
    let light = Math.max(dawn, dusk, isDay ? 0 : 0.45);
    const cloud = H.cloud_cover ? H.cloud_cover[i] : 0;
    if (isDay && cloud >= 70) light = Math.max(light, 0.5);

    const major = nearestWin(ms, ev.majors, 60 * 60000), minor = nearestWin(ms, ev.minors, 45 * 60000);
    const solunar = Math.max(major, 0.6 * minor, 0.15) * phaseFactor;

    const speed = currentSpeed(ms), turn = turnBonus(ms);
    const tide = 0.6 * speed + 0.4 * turn;
    const wind = windScore(H.wind_speed_10m[i]);

    let pres = 0.5;
    if (H.surface_pressure) { const dp = H.surface_pressure[i] - H.surface_pressure[Math.max(0, i - 4)]; pres = dp <= -2 ? 1 : dp <= -0.5 ? 0.8 : dp < 0.5 ? 0.55 : dp < 2 ? 0.35 : 0.2; }

    let score = 100 * (0.30 * tide + 0.25 * light + 0.20 * solunar + 0.15 * wind + 0.10 * pres);
    if (H.wind_gusts_10m[i] >= TH.gustRed) score = Math.min(score, 25); // unfishable/unsafe cap

    const reasons = [];
    if (dawn > 0.5) reasons.push('dawn'); else if (dusk > 0.5) reasons.push('dusk'); else if (!isDay) reasons.push('night');
    if (turn > 0.5) reasons.push('tide turn'); else if (speed > 0.6) reasons.push('strong current');
    if (major > 0.4) reasons.push('major solunar'); else if (minor > 0.4) reasons.push('minor solunar');
    if (pres >= 0.8) reasons.push('falling barometer');
    if (isDay && cloud >= 70 && dawn < 0.5 && dusk < 0.5) reasons.push('overcast');
    if (wind < 0.25) reasons.push('too windy');
    return { ms, i, score, reasons };
  });

  // group consecutive qualifying hours into windows
  const windows = [];
  let w = null;
  for (const h of data) {
    if (h.score >= 52 && !h.reasons.includes('too windy')) {
      if (!w) w = { start: h.ms, end: h.ms, peak: h.score, reasons: new Set(h.reasons) };
      else { w.end = h.ms; w.peak = Math.max(w.peak, h.score); h.reasons.forEach((r) => w.reasons.add(r)); }
    } else if (w) { windows.push(w); w = null; }
  }
  if (w) windows.push(w);
  windows.sort((a, b) => b.peak - a.peak);

  const scoreByMs = {};
  data.forEach((h) => { scoreByMs[h.ms] = h.score; });
  return { scoreByMs, windows: windows.slice(0, 3), illum };
}

function dayLabel(ms) {
  const d = new Date(ms), t = new Date(), tom = new Date(t.getTime() + M_DAYMS);
  if (d.toDateString() === t.toDateString()) return 'Today';
  if (d.toDateString() === tom.toDateString()) return 'Tomorrow';
  return d.toLocaleDateString([], { weekday: 'short' });
}

function renderFishing(f) {
  const el = $('fishing-content');
  if (!f) { el.innerHTML = '<div class="text-sm text-slate-400">Fishing outlook unavailable</div>'; return; }
  const stars = (n) => `<span class="text-amber-500">${'★'.repeat(n)}</span><span class="text-slate-300 dark:text-slate-600">${'★'.repeat(5 - n)}</span>`;
  // realistic peaks: ~45 poor, ~60 decent, ~72 good, ~82 excellent
  const starCount = (p) => (p >= 74 ? 5 : p >= 64 ? 4 : p >= 55 ? 3 : p >= 45 ? 2 : 1);
  const rows = f.windows.map((w) => {
    const n = starCount(w.peak);
    let rs = [...w.reasons].filter((r) => r !== 'too windy');
    if (rs.includes('dawn') || rs.includes('dusk')) rs = rs.filter((r) => r !== 'night'); // dawn/dusk supersede night
    const reasons = rs.slice(0, 3).join(' · ') || 'favorable mix';
    return `<div class="py-1.5 border-b border-black/5 dark:border-white/5 last:border-0">
      <div class="flex items-center gap-2">
        <span class="text-sm shrink-0">${stars(n)}</span>
        <span class="text-sm font-semibold">${dayLabel(w.start)} ${fmtTime(new Date(w.start))}–${fmtTime(new Date(w.end + 3600000))}</span>
      </div>
      <div class="text-xs text-slate-500 dark:text-slate-400 capitalize mt-0.5">${reasons}</div>
    </div>`;
  }).join('') || '<div class="text-sm text-slate-400">No standout windows in the next 48h — fish moving water around the tide changes.</div>';
  el.innerHTML = `
    <div class="text-[11px] uppercase tracking-wide text-slate-400 font-semibold mb-2">🎣 Fishing Outlook · ${moonPhaseName()}</div>
    ${rows}`;
}

/* ---------------- orchestration ---------------- */
function spinRefresh(on) {
  const el = $('refresh-icon');
  el.style.transition = on ? 'transform 1s linear infinite' : '';
  el.style.animation = on ? 'spin 1s linear infinite' : '';
}

async function loadAll() {
  const loc = state.loc;
  $('refresh-btn').classList.add('opacity-50', 'pointer-events-none');
  $('refresh-icon').style.animation = 'spin 1s linear infinite';

  // Render sun immediately (no network)
  renderSun(loc);

  const [om, marine, tides, alerts, currentCp, obs] = await Promise.all([
    fetchOpenMeteo(loc).catch((e) => { console.error('open-meteo', e); return null; }),
    fetchMarine(loc),
    fetchTides(loc),
    fetchAlerts(loc.zone),
    loc.current ? fetchCurrent(loc.current) : Promise.resolve([]),
    fetchObs(loc.obs).catch(() => null),
  ]);

  // Build the unified "now" snapshot
  const cur = om && om.current ? om.current : {};
  const mc = marine && marine.current ? marine.current : {};
  const warning = alerts.find((a) => /warning/i.test(a.event));
  // Prefer observed water temp from the CO-OPS station; fall back to model SST.
  const waterObs = obs && obs.waterF != null;
  const d = {
    wind: cur.wind_speed_10m, gust: cur.wind_gusts_10m, windDir: cur.wind_direction_10m,
    airF: cur.temperature_2m, visNm: mToNm(cur.visibility), weatherCode: cur.weather_code,
    wave: mc.wave_height, wavePeriod: mc.wave_period,
    waterF: waterObs ? obs.waterF : cToF(mc.sea_surface_temperature),
    waterSrc: waterObs ? (loc.obsName || 'observed') : (mc.sea_surface_temperature != null ? 'model' : null),
    obsWind: obs ? obs.obsWind : null, obsGust: obs ? obs.obsGust : null, obsWindDir: obs ? obs.obsWindDir : null,
    activeWarning: warning ? warning.event : null,
  };

  renderAlerts(alerts);
  renderVerdict(computeVerdict(d));
  renderNow(d);
  renderTides(tides, loc);
  renderCurrents(currentCp, loc);
  const fishing = computeFishing(om, tides, currentCp, loc);
  renderFishing(fishing);
  if (om) renderHourly(om, marine, fishing);

  state.data = { d, at: Date.now() };
  try { localStorage.setItem('mw-cache-' + loc.id, JSON.stringify({ at: Date.now(), d })); } catch (e) {}
  updateTimestamp();

  $('refresh-btn').classList.remove('opacity-50', 'pointer-events-none');
  $('refresh-icon').style.animation = '';
}

async function loadMarineText() {
  if (state.forecastZones.length) return; // once
  try {
    const text = await fetchCwfText();
    state.forecastZones = parseForecast(text);
    if (!state.forecastZones.length) throw new Error('No zones parsed');
    $('marine-loading').classList.add('hidden');
    $('forecast-container').classList.remove('hidden');
    renderZoneNav(state.forecastZones);
  } catch (e) {
    console.error('CWF', e);
    $('marine-loading').classList.add('hidden');
    $('marine-error').classList.remove('hidden');
    $('marine-error').textContent = 'Could not load NWS forecast text. ' + e.message;
  }
}

function updateTimestamp() {
  if (!state.data) return;
  const mins = Math.round((Date.now() - state.data.at) / 60000);
  $('updated-at').textContent = '· updated ' + (mins < 1 ? 'just now' : mins + 'm ago');
}

/* ---------------- UI wiring ---------------- */
function buildLocationSelect() {
  $('location-select').innerHTML = LOCATIONS.map((l) => `<option value="${l.id}">${l.name}</option>`).join('');
  const saved = localStorage.getItem('mw-loc');
  if (saved) {
    const f = LOCATIONS.find((l) => l.id === saved);
    if (f) { state.loc = f; $('location-select').value = f.id; }
  }
  $('location-select').addEventListener('change', (e) => {
    state.loc = LOCATIONS.find((l) => l.id === e.target.value) || LOCATIONS[0];
    localStorage.setItem('mw-loc', state.loc.id);
    state.forecastZones = [];
    $('marine-loading').classList.remove('hidden');
    $('forecast-container').classList.add('hidden');
    $('marine-error').classList.add('hidden');
    loadAll();
    if (!$('tab-marine').classList.contains('hidden')) loadMarineText();
  });
}

function setupTabs() {
  const buttons = document.querySelectorAll('.tab-btn');
  const panels = ['hourly', 'marine', 'windy', 'radar'];
  const ACTIVE = ['bg-blue-600', 'text-white'];
  const IDLE = ['text-slate-500', 'hover:bg-black/5', 'dark:hover:bg-white/10'];
  function show(name) {
    panels.forEach((p) => $('tab-' + p).classList.toggle('hidden', p !== name));
    buttons.forEach((b) => {
      const on = b.dataset.tab === name;
      b.classList.toggle('bg-blue-600', on); b.classList.toggle('text-white', on);
      b.classList.toggle('text-slate-500', !on);
    });
    if (name === 'marine') loadMarineText();
    if (name === 'windy') mountWindy();
    if (name === 'windy' || name === 'radar') window.dispatchEvent(new Event('resize'));
  }
  buttons.forEach((b) => { b.classList.add(...IDLE); b.addEventListener('click', () => show(b.dataset.tab)); });
  show('hourly');
}

let windyMounted = false;
function mountWindy() {
  if (windyMounted) return;
  windyMounted = true;
  const mount = $('windy-mount');
  mount.innerHTML = '';
  const div = document.createElement('div');
  div.setAttribute('data-windywidget', 'forecast');
  div.setAttribute('data-spotid', '7813759');
  div.setAttribute('data-thememode', document.documentElement.classList.contains('dark') ? 'black' : 'white');
  div.setAttribute('data-windunit', 'knots');
  div.setAttribute('data-tempunit', 'F');
  div.setAttribute('data-appid', 'b4ecac6222ef833416708274c19725f2');
  mount.appendChild(div);
  const s = document.createElement('script');
  s.async = true; s.dataset.cfasync = 'false';
  s.src = 'https://windy.app/widgets-code/forecast/windy_forecast_async.js?v168';
  mount.appendChild(s);
}

function setupTheme() {
  $('theme-btn').addEventListener('click', () => {
    const dark = document.documentElement.classList.toggle('dark');
    localStorage.setItem('mw-theme', dark ? 'dark' : 'light');
  });
}

function setupGeo() {
  $('geo-btn').addEventListener('click', () => {
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition((pos) => {
      const { latitude, longitude } = pos.coords;
      // snap to nearest preset area
      let best = LOCATIONS[0], bd = Infinity;
      for (const l of LOCATIONS) {
        const dist = (l.lat - latitude) ** 2 + (l.lon - longitude) ** 2;
        if (dist < bd) { bd = dist; best = l; }
      }
      state.loc = best; $('location-select').value = best.id;
      localStorage.setItem('mw-loc', best.id);
      state.forecastZones = [];
      loadAll();
    }, () => {}, { timeout: 8000 });
  });
}

/* keyframe for the spinner (Tailwind has animate-spin but we toggle inline) */
const styleEl = document.createElement('style');
styleEl.textContent = '@keyframes spin{to{transform:rotate(360deg)}}';
document.head.appendChild(styleEl);

/* ---------------- boot ---------------- */
function boot() {
  buildLocationSelect();
  setupTabs();
  setupTheme();
  setupGeo();
  $('refresh-btn').addEventListener('click', loadAll);
  loadAll();
  setInterval(updateTimestamp, 30000);
  // refresh when returning to the app
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && state.data && Date.now() - state.data.at > 5 * 60000) loadAll();
  });
  // PWA
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}
boot();
