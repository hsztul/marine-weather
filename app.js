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

// Boating areas on the Sound. Currents (The Race / Plum Gut) are shown
// globally since they're the gates everyone crosses, so presets only vary
// point location, NWS marine zone, and nearest tide station.
const LOCATIONS = [
  { id: 'west',    name: 'Western LI Sound',  lat: 41.05, lon: -73.40, zone: 'ANZ335', tide: '8516945', tideName: 'Kings Point' },
  { id: 'central', name: 'Central LI Sound',  lat: 41.10, lon: -73.10, zone: 'ANZ335', tide: '8467150', tideName: 'Bridgeport' },
  { id: 'east',    name: 'Eastern LI Sound',  lat: 41.18, lon: -72.55, zone: 'ANZ332', tide: '8461490', tideName: 'New London' },
];

// Tidal-current gates (always relevant for a Sound crossing)
const CURRENT_STATIONS = [
  { id: 'LIS1001', name: 'The Race' },
  { id: 'LIS1012', name: 'Plum Gut' },
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
    '&hourly=wind_speed_10m,wind_gusts_10m,wind_direction_10m,visibility,precipitation_probability,weather_code,temperature_2m' +
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
    statCard('Water', round(d.waterF), '°F', ''),
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

function renderCurrents(sets) {
  const now = new Date();
  const blocks = sets.map(({ name, cp }) => {
    const next = cp.map((c) => ({ when: parseNoaa(c.Time), type: c.Type, vel: c.Velocity_Major }))
      .filter((c) => c.when > now).slice(0, 2);
    if (!next.length) return `<div><div class="text-sm font-semibold">${name}</div><div class="text-xs text-slate-400">unavailable</div></div>`;
    const items = next.map((c) => {
      const label = c.type === 'slack' ? 'Slack'
        : c.type === 'flood' ? `Flood ${Math.abs(c.vel).toFixed(1)} kt`
        : `Ebb ${Math.abs(c.vel).toFixed(1)} kt`;
      const dir = c.type === 'flood' ? '→ W' : c.type === 'ebb' ? '← E' : '·';
      return `<div class="flex justify-between text-sm"><span>${label} <span class="text-slate-400 text-xs">${dir}</span></span><span class="font-medium">${fmtTime(c.when)}</span></div>`;
    }).join('');
    return `<div class="flex-1 min-w-[140px]"><div class="text-sm font-semibold mb-1">🌀 ${name}</div>${items}</div>`;
  }).join('');
  $('currents-card').innerHTML = `
    <div class="text-[11px] uppercase tracking-wide text-slate-400 font-semibold mb-2">Tidal Currents — crossing gates</div>
    <div class="flex flex-wrap gap-4">${blocks}</div>`;
}

function renderSun(loc) {
  const today = new Date();
  const { sunrise, sunset } = sunTimes(today, loc.lat, loc.lon);
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
function renderHourly(om, marine) {
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
    return `<div class="flex items-center gap-1.5 py-1.5 border-b border-black/5 dark:border-white/5 last:border-0">
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
    </div>${rows}`;
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

  const [om, marine, tides, alerts, raceCp, plumCp] = await Promise.all([
    fetchOpenMeteo(loc).catch((e) => { console.error('open-meteo', e); return null; }),
    fetchMarine(loc),
    fetchTides(loc),
    fetchAlerts(loc.zone),
    fetchCurrent('LIS1001'),
    fetchCurrent('LIS1012'),
  ]);

  // Build the unified "now" snapshot
  const cur = om && om.current ? om.current : {};
  const mc = marine && marine.current ? marine.current : {};
  const warning = alerts.find((a) => /warning/i.test(a.event));
  const d = {
    wind: cur.wind_speed_10m, gust: cur.wind_gusts_10m, windDir: cur.wind_direction_10m,
    airF: cur.temperature_2m, visNm: mToNm(cur.visibility), weatherCode: cur.weather_code,
    wave: mc.wave_height, wavePeriod: mc.wave_period, waterF: cToF(mc.sea_surface_temperature),
    activeWarning: warning ? warning.event : null,
  };

  renderAlerts(alerts);
  renderVerdict(computeVerdict(d));
  renderNow(d);
  renderTides(tides, loc);
  renderCurrents([{ name: 'The Race', cp: raceCp }, { name: 'Plum Gut', cp: plumCp }]);
  if (om) renderHourly(om, marine);

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
