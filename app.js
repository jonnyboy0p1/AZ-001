const STORAGE_KEY = 'ob_prc_vscode_app_state_v1';
const SHIFT_LOG_KEY = 'ob_prc_vscode_shift_results_log_v1';
const LEGACY_SHIFT_LOG_KEY = 'OB_PERIOD_REPORT_CARD_SHIFT_LOGS';
const XBELT_LOG_KEY = 'ob_prc_vscode_xbelt_downtime_log_v1';
const THEME_KEY = 'ob_prc_vscode_app_theme';
const FOCUS_KEY = 'ob_prc_vscode_app_focus';
const TOP_KEY = 'ob_prc_vscode_app_top_min';
const COPY_BLOCK_KEY = 'ob_prc_vscode_copy_block_min';
const NOTES_WASH_KEY = 'ob_prc_vscode_notes_wash_min';
const VIEW_KEY = 'ob_prc_vscode_active_view';
const PACE_STREAM_KEY = 'ob_prc_vscode_pace_stream';
const FCLM_SOURCE_COLLAPSE_KEY = 'ob_prc_vscode_fclm_source_collapsed';
const PERIOD_CHECKLIST_COLLAPSE_KEY = 'ob_prc_vscode_period_checklist_collapsed';
const PACE_STATUS_COLLAPSE_KEY = 'ob_prc_vscode_pace_status_collapsed';
const COPY_BLOCK_EDITED_KEY = 'ob_prc_vscode_copy_block_edited';
const PERIOD_SUMMARY_EDITED_KEY = 'ob_prc_vscode_period_summary_edited';
const EOS_SUMMARY_EDITED_KEY = 'ob_prc_vscode_eos_summary_edited';
const MANUAL_LOCKS_KEY = 'ob_prc_vscode_manual_locks';
const FLUID_ROSTER_URL = 'https://zone-ra.amazon.dev/roster/rfd2/ob/fluid/';
let generatedCopyEdited = false;
let periodSummaryEdited = false;
let eosSummaryEdited = false;
let currentShiftLogEntry = null;
let fclmAutoRefreshTimer = null;
let bridgeRefreshPollTimer = null;
let manualLocks = new Set();
let latestBridgePayload = null;

const SERVER_BRIDGE_URL = '/bridge';
let serverBridgePollTimer = null;
let lastServerBridgeTs = 0;

const BRIDGE_SOURCE_LABELS = {
  all: 'FCLM, FL Utilization, and Battle of the Belt',
  fclm: 'FCLM',
  flUtil: 'FL Utilization',
  belt: 'Battle of the Belt',
  neo: 'NEO',
  roster: 'Fluid Roster',
  dashboard: 'Dashboard'
};

const PERIODS = [
  { key: 'p1', label: 'P1', hours: 4 },
  { key: 'p2', label: 'P2', hours: 3 },
  { key: 'p3', label: 'P3', hours: 2.5 },
  { key: 'met', label: 'MET', hours: 1 }
];

const $ = (id) => document.getElementById(id);

function localDateString(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function defaultShiftDateString(now = new Date()) {
  const shiftDate = new Date(now);
  if (now.getHours() < 12) shiftDate.setDate(shiftDate.getDate() - 1);
  return localDateString(shiftDate);
}

function num(v) {
  if (v == null || v === '') return 0;
  const n = Number(String(v).replace(/,/g, '').replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

function fmt(n, d = 0) {
  return Number(n || 0).toLocaleString('en-US', {
    minimumFractionDigits: d,
    maximumFractionDigits: d
  });
}

function pct(n, d = 1) {
  return `${fmt(n, d)}%`;
}

function signed(n, d = 0) {
  const clean = num(n);
  return `${clean >= 0 ? '+' : ''}${fmt(clean, d)}`;
}

function val(id) {
  return num($(id)?.value);
}

function setVal(id, value, d = 0) {
  const el = $(id);
  if (!el || value == null || value === '') return;
  if (isManualLocked(id)) return;
  el.value = fmt(num(value), d);
}

function setText(id, text, cls = '') {
  const el = $(id);
  if (!el) return;
  el.textContent = text;
  el.classList.remove('good', 'bad', 'warn');
  if (cls) el.classList.add(cls);
}

function setHtml(id, html, cls = '') {
  const el = $(id);
  if (!el) return;
  el.innerHTML = html;
  el.classList.remove('good', 'bad', 'warn');
  if (cls) el.classList.add(cls);
}

function flashCopy(btn) {
  if (!btn || btn.dataset.copying) return;
  const orig = btn.textContent;
  btn.textContent = '✓ Copied';
  btn.dataset.copying = '1';
  btn.classList.add('copy-success');
  setTimeout(() => {
    btn.textContent = orig;
    delete btn.dataset.copying;
    btn.classList.remove('copy-success');
  }, 1500);
}

function updateLiveClock() {
  const el = $('liveClock');
  if (!el) return;
  const now = new Date();
  const ct = new Intl.DateTimeFormat('en-US', {
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'America/Chicago'
  }).format(now);
  const parts = new Intl.DateTimeFormat('en-US', {
    hour: 'numeric', minute: 'numeric', hourCycle: 'h23', timeZone: 'America/Chicago'
  }).formatToParts(now);
  const h = Number(parts.find((p) => p.type === 'hour')?.value || 0);
  const m = Number(parts.find((p) => p.type === 'minute')?.value || 0);
  const t = h * 60 + m;
  const isMetShift = $('useMET')?.value === 'true';
  let label = '--', cls = '';
  if (t >= 19 * 60 && t < 23 * 60) { label = 'P1'; cls = 'good'; }
  else if (t >= 23 * 60 && t < 23 * 60 + 30) { label = 'Break'; cls = 'warn'; }
  else if (t >= 23 * 60 + 30 || t < 2 * 60 + 30) { label = 'P2'; cls = 'good'; }
  else if (t >= 2 * 60 + 30 && t < 3 * 60) { label = 'Break'; cls = 'warn'; }
  else if (t >= 3 * 60 && t < 5 * 60 + 30) { label = 'P3'; cls = 'good'; }
  else if (isMetShift && t >= 5 * 60 + 30 && t < 6 * 60 + 30) { label = 'MET'; cls = 'warn'; }
  el.textContent = `${ct} CT · ${label}`;
  el.className = `mini live-clock${cls ? ` ${cls}` : ''}`;
}

function updateShiftProgressBar(rows) {
  const fill = $('shiftProgressFill');
  if (!fill) return;
  const totalHours = rows.reduce((sum, p) => sum + effectivePeriodHours(p), 0);
  if (!totalHours) { fill.style.width = '0%'; return; }
  let elapsed = 0;
  for (const p of rows) {
    for (const seg of periodHourSegments(p.key)) {
      if (seg.state === 'complete') elapsed += seg.effectiveHours ?? seg.hours;
      else if (seg.state === 'current') elapsed += seg.elapsedHours;
    }
  }
  const pct = Math.min(100, elapsed / totalHours * 100);
  fill.style.width = `${pct.toFixed(1)}%`;
  const bar = $('shiftProgressBar');
  if (bar) bar.title = `${Math.round(pct)}% through shift · ${fmt(elapsed, 1)} of ${fmt(totalHours, 1)} hrs elapsed`;
}

function renderBridgeSourceAges() {
  const el = $('bridgeSourceAges');
  if (!el) return;
  const bridge = latestBridgePayload || readStoredBridgePayload();
  if (!bridge) { el.innerHTML = '<span class="source-age-chip">No bridge data yet</span>'; return; }
  const fclmTs = Math.max(
    num(bridge.fclmFull?.updatedAt),
    ...Object.values(bridge.fclmPeriods || {}).map((r) => num(r?.updatedAt))
  );
  const flUtilTs = Math.max(
    num(bridge.monitorFull?.flUtil?.updatedAt),
    ...Object.values(bridge.monitorPeriods || {}).map((r) => num(r?.flUtil?.updatedAt))
  );
  const beltTs = Math.max(
    num(bridge.monitorFull?.belt?.updatedAt),
    ...Object.values(bridge.monitorPeriods || {}).map((r) => num(r?.belt?.updatedAt))
  );
  const neoTs = num(bridge.neo?.updatedAt);
  const rosterTs = num(bridge.roster?.fluid?.updatedAt);
  const ageClass = (ts) => {
    if (!ts) return '';
    const min = (Date.now() - ts) / 60000;
    return min <= 15 ? 'good' : min <= 60 ? 'warn' : 'bad';
  };
  const chips = [
    { label: 'NEO', ts: neoTs },
    { label: 'FCLM', ts: fclmTs },
    { label: 'FL Util', ts: flUtilTs },
    { label: 'Belt', ts: beltTs },
    { label: 'Roster', ts: rosterTs }
  ];
  el.innerHTML = chips.map((c) =>
    `<span class="source-age-chip ${ageClass(c.ts)}">${c.label}: ${c.ts ? formatBridgeAge(c.ts) : '—'}</span>`
  ).join('');
}

function renderLiveBridgeStatus() {
  const grid = $('liveStatusGrid');
  if (!grid) return;
  const bridge = latestBridgePayload || readStoredBridgePayload();
  const heartbeat = $('liveStatusHeartbeat');
  if (!bridge) {
    if (heartbeat) { heartbeat.textContent = 'Waiting for bridge…'; heartbeat.className = 'source-age-chip'; }
    grid.innerHTML = '<div class="live-status-card"><div class="ls-title">No bridge data yet</div><div class="ls-row"><span class="ls-label">Enable the Tampermonkey script, then hit Collect / Pull Now.</span></div></div>';
    return;
  }

  const includeMET = $('useMET')?.value === 'true';
  const p = bridge.fclmPeriods || {};
  const m = bridge.monitorPeriods || {};
  const roster = bridge.roster?.fluid || {};
  const lastPull = bridge.lastPull;

  const ageSpan = (ts) => {
    const ms = num(ts);
    if (!ms) return '<span class="ls-age never">—</span>';
    const min = (Date.now() - ms) / 60000;
    const cls = min <= 15 ? '' : min <= 60 ? ' stale' : ' old';
    return `<span class="ls-age${cls}">${formatBridgeAge(ms)}</span>`;
  };
  const row = (label, value) => `<div class="ls-row"><span class="ls-label">${label}</span><span class="ls-value">${value}</span></div>`;
  const gapSpan = (gap) => gap == null || Number.isNaN(gap) ? '' : ` <span class="${gap >= 0 ? 'ls-pos' : 'ls-neg'}">(${gap >= 0 ? '+' : ''}${fmt(gap)})</span>`;

  const zoneRows = (roster.groups || []).map((g) => {
    const gap = g.target ? num(g.current) - num(g.target) : null;
    return row(g.label, `${fmt(g.current)}${g.target ? `/${fmt(g.target)}` : ''}${gapSpan(gap)}`);
  }).join('');

  const fclmRow = (key, label) => row(label, `Jobs ${fmt(p[key]?.totalJobs)} · JPLH ${fmt(p[key]?.jplh, 2)} · ${ageSpan(p[key]?.updatedAt)}`);
  const monitorRow = (key, label) => row(label, `FL ${ageSpan(m[key]?.flUtil?.updatedAt)} · Belt ${ageSpan(m[key]?.belt?.updatedAt)}`);

  grid.innerHTML = `
    <div class="live-status-card">
      <div class="ls-title">Sources</div>
      ${row('NEO', ageSpan(bridge.neo?.updatedAt))}
      ${row('Fluid Roster', ageSpan(roster.updatedAt))}
      ${row('FCLM Full', ageSpan(bridge.fclmFull?.updatedAt))}
      ${row('Last Pull', lastPull?.label ? `${lastPull.label} ${ageSpan(lastPull.updatedAt)}` : '<span class="ls-age never">Waiting</span>')}
    </div>
    <div class="live-status-card">
      <div class="ls-title">Fluid Roster</div>
      ${row('Headcount', `${fmt(roster.headcount)}${roster.target ? `/${fmt(roster.target)}` : ''}${gapSpan(roster.gap != null ? num(roster.gap) : null)}`)}
      ${zoneRows || row('Zones', '<span class="ls-age never">—</span>')}
    </div>
    <div class="live-status-card">
      <div class="ls-title">FCLM</div>
      ${fclmRow('p1', 'P1')}
      ${fclmRow('p2', 'P2')}
      ${fclmRow('p3', 'P3')}
      ${includeMET ? fclmRow('met', 'MET') : ''}
    </div>
    <div class="live-status-card">
      <div class="ls-title">Monitor</div>
      ${monitorRow('p1', 'P1')}
      ${monitorRow('p2', 'P2')}
      ${monitorRow('p3', 'P3')}
      ${includeMET ? monitorRow('met', 'MET') : ''}
    </div>
  `;

  if (heartbeat) {
    const newest = Math.max(
      num(lastPull?.updatedAt), num(bridge.updatedAt), num(roster.updatedAt),
      num(bridge.neo?.updatedAt), num(bridge.fclmFull?.updatedAt),
      ...Object.values(p).map((r) => num(r?.updatedAt)),
      ...Object.values(m).flatMap((r) => [num(r?.flUtil?.updatedAt), num(r?.belt?.updatedAt)])
    );
    const min = newest ? (Date.now() - newest) / 60000 : Infinity;
    heartbeat.textContent = newest ? `Live · updated ${formatBridgeAge(newest)}` : 'Waiting for bridge…';
    heartbeat.className = `source-age-chip ${newest ? (min <= 15 ? 'good' : min <= 60 ? 'warn' : 'bad') : ''}`;
  }
}

function on(id, event, handler) {
  const el = $(id);
  if (el) el.addEventListener(event, handler);
}

function loadManualLocks() {
  try {
    manualLocks = new Set(JSON.parse(localStorage.getItem(MANUAL_LOCKS_KEY) || '[]'));
  } catch {
    manualLocks = new Set();
  }
}

function saveManualLocks() {
  localStorage.setItem(MANUAL_LOCKS_KEY, JSON.stringify([...manualLocks]));
}

function protectManualOverridesOn() {
  return $('protectManualOverrides')?.checked !== false;
}

function isManualLocked(id) {
  return protectManualOverridesOn() && manualLocks.has(id);
}

function markManualLock(id) {
  if (!id || !protectManualOverridesOn()) return;
  manualLocks.add(id);
  saveManualLocks();
  updateManualOverrideStatus();
}

function clearManualLocks() {
  manualLocks.clear();
  saveManualLocks();
  updateManualOverrideStatus();
  updateMiniStatus('Manual override locks cleared.');
}

function updateManualOverrideStatus() {
  const el = $('manualOverrideStatus');
  if (!el) return;
  el.textContent = protectManualOverridesOn()
    ? `${manualLocks.size} manual field${manualLocks.size === 1 ? '' : 's'} protected from auto-pulls.`
    : 'Manual override protection is off.';
}

function shouldManualLockInput(el) {
  if (!el?.id || el.dataset.projectionAuto === 'true') return false;
  if (el.type !== 'number' && el.tagName !== 'INPUT') return false;
  return ![
    'shiftDate',
    'protectManualOverrides',
    'autoFclmRefresh'
  ].includes(el.id);
}

function colorClass(v) {
  if (v > 0) return 'good';
  if (v < 0) return 'bad';
  return 'warn';
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function activePeriods() {
  return PERIODS.filter((p) => $('useMET').value === 'true' || p.key !== 'met');
}

function monitorFullFlUtil() {
  const full = latestBridgePayload?.monitorFull?.flUtil || readStoredBridgePayload()?.monitorFull?.flUtil;
  if (!full) return null;
  const fl = num(full.fl);
  const mp = num(full.mp);
  const rwc = num(full.rwc);
  return fl || mp || rwc ? { fl, mp, rwc, total: fl + mp + rwc, updatedAt: full.updatedAt } : null;
}

function medianValue(values) {
  const clean = values.map(num).filter((value) => value > 0).sort((a, b) => a - b);
  if (!clean.length) return 0;
  const mid = Math.floor(clean.length / 2);
  return clean.length % 2 ? clean[mid] : Math.round((clean[mid - 1] + clean[mid]) / 2);
}

function periodFlUtilCapture(key) {
  return val(`${key}_flu_fl`) + val(`${key}_flu_mp`) + val(`${key}_flu_rwc`);
}

function periodFclmJobs(key) {
  const jobs = val(`${key}_jobs`);
  return jobs || val(`${key}_totes`) + val(`${key}_cases`);
}

function periodActualCapture(key) {
  return medianValue([periodFlUtilCapture(key), periodFclmJobs(key)]);
}

function periodActualCaptureTotal(rows = activePeriods()) {
  return rows.reduce((sum, row) => sum + periodActualCapture(row.key), 0);
}

function downtimeMinutes(key) {
  const amount = clamp(val(`${key}_downtime_amount`), 0, 12);
  const unit = $(`${key}_downtime_unit`)?.value || 'min';
  return unit === 'hr' ? amount * 60 : amount;
}

function downtimeHours(key) {
  return downtimeMinutes(key) / 60;
}

function formatDowntime(minutes) {
  const clean = num(minutes);
  if (!clean) return '0 min';
  if (clean % 60 === 0) return `${fmt(clean / 60, 0)} hr`;
  if (clean >= 60) return `${fmt(clean / 60, 2)} hr`;
  return `${fmt(clean, 0)} min`;
}

function effectivePeriodHours(row) {
  return Math.max(0, row.hours - downtimeHours(row.key));
}

function downtimeReason(key) {
  return $(`${key}_downtime_reason`)?.value || 'none';
}

function downtimeNotes(rows = activePeriods()) {
  return rows
    .map((row) => {
      const minutes = downtimeMinutes(row.key);
      if (!minutes) return null;
      const reason = downtimeReason(row.key);
      const label = reason === 'xbelt' ? 'X-belt down' : reason === 'system' ? 'System down' : reason === 'no-run' ? 'No-run bypass' : 'Bypass';
      return `${row.label}: ${formatDowntime(minutes)} ${label}`;
    })
    .filter(Boolean);
}

function addDays(y, m, d, days) {
  const date = new Date(Date.UTC(y, m - 1, d + days, 12, 0, 0));
  return { y: date.getUTCFullYear(), m: date.getUTCMonth() + 1, d: date.getUTCDate() };
}

function addDaysToIso(dateStr, days) {
  const [y, m, d] = (dateStr || localDateString()).split('-').map(Number);
  const next = addDays(y, m, d, days);
  return `${next.y}-${String(next.m).padStart(2, '0')}-${String(next.d).padStart(2, '0')}`;
}

function compareIsoDates(a, b) {
  return String(a || '').localeCompare(String(b || ''));
}

function resetShiftDateTarget(selectedDate) {
  const currentShiftDate = defaultShiftDateString();
  const current = selectedDate || currentShiftDate;
  const nextSelectedDate = addDaysToIso(current, 1);
  return compareIsoDates(nextSelectedDate, currentShiftDate) < 0 ? currentShiftDate : nextSelectedDate;
}

function getOffsetMinutes(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    timeZoneName: 'shortOffset',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(date);
  const tzName = parts.find((p) => p.type === 'timeZoneName')?.value || 'GMT-0';
  const match = tzName.match(/GMT([+-]\d{1,2})(?::?(\d{2}))?/i);
  if (!match) return 0;
  const h = Number(match[1]);
  const m = Number(match[2] || 0);
  const sign = h >= 0 ? 1 : -1;
  return h * 60 + sign * m;
}

function zonedTimeToUtc(y, m, d, hour, minute, timeZone = 'America/Chicago') {
  let guess = new Date(Date.UTC(y, m - 1, d, hour, minute, 0));
  for (let i = 0; i < 2; i += 1) {
    const offset = getOffsetMinutes(guess, timeZone);
    guess = new Date(Date.UTC(y, m - 1, d, hour, minute, 0) - offset * 60000);
  }
  return guess;
}

function isoNoMs(date) {
  return date.toISOString().replace('.000Z', 'Z');
}

function monitorUrlString(url) {
  return url.toString().replace(/\+/g, '%20');
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[char]));
}

function saveState(showStatus = true) {
  const state = {};
  document.querySelectorAll('input, select, textarea').forEach((el) => {
    if (!el.id) return;
    if (el.dataset.projectionAuto === 'true') return;
    state[el.id] = el.type === 'checkbox' ? el.checked : el.value;
  });
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  updateSaveCounter();
  if (showStatus) $('miniStatus').textContent = 'Working board saved.';
}

function updateSaveCounter(log = loadShiftLog()) {
  const el = $('saveCounter');
  if (!el) return;
  const date = currentShiftLogEntry?.date || $('shiftDate')?.value || new Date().toISOString().slice(0, 10);
  const week = weekSunToWed(date);
  const weekEntries = log.filter((item) => week.dates.includes(item.date));
  const savedForDate = log.find((item) => item.date === date);
  el.textContent = `${savedForDate ? 'Current saved' : 'Current not saved'} | Week ${weekEntries.length}/4`;
  el.classList.toggle('good', !!savedForDate);
  el.classList.toggle('warn', !savedForDate);
}

function loadState() {
  try {
    const state = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    Object.entries(state).forEach(([id, value]) => {
      if (!$(id)) return;
      if ($(id).type === 'checkbox') $(id).checked = value === true || value === 'true';
      else $(id).value = value;
    });
  } catch {}
}

function applyTheme(theme) {
  const next = theme || localStorage.getItem(THEME_KEY) || 'midnight';
  document.body.classList.remove('theme-midnight', 'theme-light', 'theme-darkwhite', 'theme-ice', 'theme-forest');
  document.body.classList.add(`theme-${next}`);
  $('themeSelect').value = next;
  $('themeChip').textContent = `Theme: ${$('themeSelect').selectedOptions[0].textContent}`;
  localStorage.setItem(THEME_KEY, next);
}

function applyFocus(value) {
  const on = String(value ?? localStorage.getItem(FOCUS_KEY) ?? 'false') === 'true';
  $('focusMode').value = String(on);
  document.body.classList.toggle('focus-mode', on);
  localStorage.setItem(FOCUS_KEY, String(on));
}

function normalizeView(view = 'overview') {
  if (view === 'shift') return 'overview';
  if (view === 'setup' || view === 'tools') return 'goals';
  if (view === 'projection') return 'pace';
  if (view === 'output' || view === 'reports') return 'handoff';
  const valid = ['overview', 'goals', 'periods', 'pace', 'handoff', 'logs'];
  return valid.includes(view) ? view : 'overview';
}

function applyView(view = 'overview') {
  const active = normalizeView(view);
  document.body.dataset.view = active;
  document.querySelectorAll('[data-view]').forEach((section) => {
    const views = String(section.dataset.view || '').split(/\s+/);
    section.hidden = !views.includes(active);
  });
  document.querySelectorAll('[data-view-tab]').forEach((tab) => {
    tab.classList.toggle('active', tab.dataset.viewTab === active);
  });
  localStorage.setItem(VIEW_KEY, active);
}

function updateMetUi() {
  const isMet = $('useMET')?.value === 'true';
  document.body.classList.toggle('met-enabled', isMet);
  document.body.classList.toggle('met-disabled', !isMet);

  document.querySelectorAll('[data-met-only]').forEach((el) => {
    if (el.tagName === 'OPTION') {
      el.disabled = !isMet;
      el.hidden = !isMet;
    } else {
      el.hidden = !isMet;
    }
  });

  if (!isMet && $('embeddedMonitorPeriod')?.value === 'met') {
    $('embeddedMonitorPeriod').value = 'p3';
  }

  if ($('metChip')) {
    $('metChip').textContent = 'MET: On | 05:30 to 06:30 CT';
  }
  if ($('shiftModeChip')) {
    $('shiftModeChip').textContent = isMet
      ? 'MET Shift | 19:00 to 06:30 CT'
      : 'Regular Shift | 19:00 to 05:30 CT';
    $('shiftModeChip').classList.toggle('met-active', isMet);
  }
  if ($('useMET')) {
    $('useMET').title = isMet
      ? 'MET mode includes the 05:30 to 06:30 extension and shows MET tools.'
      : 'Regular mode keeps the board focused on P1, P2, and P3 only.';
  }
}

function buildPeriodRows() {
  const board = $('periodBoardSections');
  if (!board) return;

  const rows = (cells) => PERIODS.map((p) => `<tr data-period-row="${p.key}">
    <td><b>${p.label}</b></td>
    ${cells(p)}
  </tr>`).join('');

  board.innerHTML = `
    <section class="workboard-card wide">
      <div class="workboard-head">
        <h3>FCLM Jobs + JPLH</h3>
        <span>Totes, cases, jobs, and weighted burden by period</span>
      </div>
      <div class="table-wrap compact-table">
        <table>
          <thead><tr><th>Period</th><th>Open</th><th class="num">Hours</th><th>Totes</th><th>Cases</th><th>Jobs</th><th>WB</th><th class="num">JPLH</th><th class="num">Req</th><th class="num">Gap</th></tr></thead>
          <tbody>
            ${rows((p) => `
              <td><button class="tinybtn" data-period="${p.key}">Open</button></td>
              <td id="${p.key}_hours" class="num">0.0</td>
              <td><input id="${p.key}_totes" value="0" /></td>
              <td><input id="${p.key}_cases" value="0" /></td>
              <td><input id="${p.key}_jobs" value="0" /></td>
              <td><input id="${p.key}_wb" value="0" /></td>
              <td id="${p.key}_jplh" class="num">0.00</td>
              <td id="${p.key}_req_jplh" class="num">0.00</td>
              <td id="${p.key}_jplh_gap" class="num">0.00</td>
            `)}
            <tr class="total-row"><td><b>TOTAL</b></td><td>-</td><td id="eos_hours" class="num">0.0</td><td id="eos_totes" class="num">0</td><td id="eos_cases" class="num">0</td><td id="eos_jobs" class="num">0</td><td id="eos_wb" class="num">0</td><td id="eos_jplh" class="num">0.00</td><td id="eos_req_jplh" class="num">0.00</td><td id="eos_jplh_gap" class="num">0.00</td></tr>
          </tbody>
        </table>
      </div>
    </section>

    <section class="workboard-card">
      <div class="workboard-head"><h3>FL</h3><span>Fluid load target and actual</span></div>
      <table class="mini-table">
        <thead><tr><th>Period</th><th class="num">Goal</th><th>Actual</th><th class="num">Left</th></tr></thead>
        <tbody>
          ${rows((p) => `<td id="${p.key}_g_fl" class="num">0</td><td><input id="${p.key}_flu_fl" value="0" /></td><td id="${p.key}_fl_remain" class="num">0</td>`)}
          <tr class="total-row"><td><b>TOTAL</b></td><td id="eos_g_fl" class="num">0</td><td id="eos_flu_fl" class="num">0</td><td id="eos_fl_remain" class="num">0</td></tr>
        </tbody>
      </table>
    </section>

    <section class="workboard-card">
      <div class="workboard-head"><h3>MP</h3><span>Manual palletize target and actual</span></div>
      <table class="mini-table">
        <thead><tr><th>Period</th><th class="num">Goal</th><th>Actual</th></tr></thead>
        <tbody>
          ${rows((p) => `<td id="${p.key}_g_mp" class="num">0</td><td><input id="${p.key}_flu_mp" value="0" /></td>`)}
          <tr class="total-row"><td><b>TOTAL</b></td><td id="eos_g_mp" class="num">0</td><td id="eos_flu_mp" class="num">0</td></tr>
        </tbody>
      </table>
    </section>

    <section class="workboard-card">
      <div class="workboard-head"><h3>RWC</h3><span>RWC target and actual</span></div>
      <table class="mini-table">
        <thead><tr><th>Period</th><th class="num">Goal</th><th>Actual</th></tr></thead>
        <tbody>
          ${rows((p) => `<td id="${p.key}_g_rwc" class="num">0</td><td><input id="${p.key}_flu_rwc" value="0" /></td>`)}
          <tr class="total-row"><td><b>TOTAL</b></td><td id="eos_g_rwc" class="num">0</td><td id="eos_flu_rwc" class="num">0</td></tr>
        </tbody>
      </table>
    </section>

    <section class="workboard-card wide">
      <div class="workboard-head"><h3>OB Capture + Remaining</h3><span>FCLM jobs compared with FL Utilization capture</span></div>
      <table class="mini-table">
        <thead><tr><th>Period</th><th class="num">Goal</th><th class="num">FCLM</th><th class="num">FL Util</th><th class="num">Actual</th><th class="num">Gap</th><th class="num">OB Left</th><th class="num">Next OB/Hr</th></tr></thead>
        <tbody>
          ${rows((p) => `<td id="${p.key}_g_total" class="num">0</td><td id="${p.key}_capture_fclm" class="num">0</td><td id="${p.key}_capture_fl_util" class="num">0</td><td id="${p.key}_capture" class="num">0</td><td id="${p.key}_capture_gap" class="num">0</td><td id="${p.key}_remain_total" class="num">0</td><td id="${p.key}_ob_need_hr" class="num">0.00</td>`)}
          <tr class="total-row"><td><b>TOTAL</b></td><td id="eos_g_total" class="num">0</td><td id="eos_capture_fclm" class="num">0</td><td id="eos_capture_fl_util" class="num">0</td><td id="eos_capture" class="num">0</td><td id="eos_capture_gap" class="num">0</td><td id="eos_remain_total" class="num">0</td><td id="eos_ob_need_hr" class="num">0.00</td></tr>
        </tbody>
      </table>
    </section>

    <section class="workboard-card wide east-west-board">
      <div class="workboard-head"><h3>East vs West</h3><span>Battle of the Belt by side</span></div>
      <table class="mini-table">
        <thead><tr><th>Period</th><th>East</th><th>West</th><th class="num">Total</th><th class="num">Gap vs FL</th></tr></thead>
        <tbody>
          ${rows((p) => `<td><input id="${p.key}_belt_east" value="0" /></td><td><input id="${p.key}_belt_west" value="0" /></td><td id="${p.key}_belt_total" class="num">0</td><td id="${p.key}_belt_gap" class="num">0</td>`)}
          <tr class="total-row"><td><b>TOTAL</b></td><td id="eos_belt_east" class="num">0</td><td id="eos_belt_west" class="num">0</td><td id="eos_belt_total" class="num">0</td><td id="eos_belt_gap" class="num">0</td></tr>
        </tbody>
      </table>
    </section>
  `;

  board.querySelectorAll('button[data-period]').forEach((btn) => {
    btn.addEventListener('click', () => openFclmPeriod(btn.dataset.period));
  });
  buildDowntimeRows();
}

function buildDowntimeRows() {
  const target = $('downtimeBypass');
  if (!target) return;
  target.innerHTML = PERIODS.map((p) => `
    <section class="downtime-card" data-period-row="${p.key}">
      <h3>${p.label} Bypass</h3>
      <div class="downtime-row">
        <div>
          <label>Reason</label>
          <select id="${p.key}_downtime_reason">
            <option value="none">No bypass</option>
            <option value="xbelt">X-belt down</option>
            <option value="system">System down</option>
            <option value="no-run">No-run window</option>
            <option value="other">Other</option>
          </select>
        </div>
        <div>
          <label>Time</label>
          <input id="${p.key}_downtime_amount" value="0" />
        </div>
        <div>
          <label>Unit</label>
          <select id="${p.key}_downtime_unit">
            <option value="min">Min</option>
            <option value="hr">Hr</option>
          </select>
        </div>
      </div>
      <div class="downtime-note">Subtracts no-run time from the live pace clock and handoff miss logic.</div>
    </section>
  `).join('');
}

function updateDowntimeVisibility(rows = activePeriods()) {
  const active = new Set(rows.map((row) => row.key));
  document.querySelectorAll('#downtimeBypass [data-period-row]').forEach((row) => {
    row.style.display = active.has(row.dataset.periodRow) ? '' : 'none';
  });
}

function plan() {
  const rows = activePeriods();
  const totalHours = rows.reduce((s, p) => s + p.hours, 0);
  const gf = val('goalFluid');
  const gm = val('goalMp');
  const gr = val('goalRwc');

  let af = 0, am = 0, ar = 0;

  return rows.map((p, i) => {
    const last = i === rows.length - 1;
    const fl = last ? Math.round(gf - af) : Math.round(gf * p.hours / totalHours);
    const mp = last ? Math.round(gm - am) : Math.round(gm * p.hours / totalHours);
    const rwc = last ? Math.round(gr - ar) : Math.round(gr * p.hours / totalHours);
    af += fl; am += mp; ar += rwc;
    return { ...p, fl, mp, rwc, total: fl + mp + rwc };
  });
}

function fluidRosterBalanceReco(groups) {
  const find = (key) => groups.find((g) => g.label.toLowerCase().includes(key));
  const west = find('west');
  const east = find('east');
  const floater = find('floater');
  if (!west || !east) return null;
  const wc = num(west.current), wt = num(west.target);
  const ec = num(east.current), et = num(east.target);
  const fc = floater ? num(floater.current) : 0;
  const ft = floater ? num(floater.target) : 4;
  const wGap = wc - wt, eGap = ec - et, fGap = fc - ft;
  if (wGap >= 0 && eGap >= 0) return { text: 'Both sides at or above target.', tone: 'good' };
  if (wGap > 0 && eGap < 0) {
    const move = Math.min(wGap, Math.abs(eGap));
    return { text: `Rebalance: move ${move} from West to East.`, tone: 'warn' };
  }
  if (eGap > 0 && wGap < 0) {
    const move = Math.min(eGap, Math.abs(wGap));
    return { text: `Rebalance: move ${move} from East to West.`, tone: 'warn' };
  }
  const wNeeds = Math.abs(wGap), eNeeds = Math.abs(eGap);
  const floaterSurplus = Math.max(0, fGap);
  if (floaterSurplus > 0) {
    const priority = wNeeds >= eNeeds ? 'West' : 'East';
    return { text: `Both short. Assign ${floaterSurplus} floater(s) to ${priority} Doors first.`, tone: 'bad' };
  }
  if (wNeeds > eNeeds) return { text: `Both short. Prioritize West (needs ${wNeeds} more vs East ${eNeeds}).`, tone: 'bad' };
  if (eNeeds > wNeeds) return { text: `Both short. Prioritize East (needs ${eNeeds} more vs West ${wNeeds}).`, tone: 'bad' };
  return { text: `Both short — West and East each need ${wNeeds} more.`, tone: 'bad' };
}

function renderGoals() {
  const ob = val('goalFluid') + val('goalMp') + val('goalRwc');
  const gap = ob - val('shipSortGoal');
  const totalH = activePeriods().reduce((s, p) => s + effectivePeriodHours(p), 0);
  const avgCapture = totalH > 0 ? ob / totalH : 0;
  const avgReqJplh = (val('fluidHC') * totalH) > 0 ? val('goalFluid') / (val('fluidHC') * totalH) : val('fluidRate');
  const plannedFluidHc = val('fluidHC');
  const rosterFluidHc = val('rosterFluidHC');
  const rosterPayload = latestBridgePayload?.roster?.fluid || {};
  const rosterTarget = num(rosterPayload.target);
  const neoFluidHc = num(latestBridgePayload?.neo?.fluidLoadHC);
  // NEO actual HC (today's need) takes priority over ZoneRA zone capacity totals
  const compareTarget = neoFluidHc || plannedFluidHc || rosterTarget;
  const rosterGap = rosterFluidHc - compareTarget;
  const rosterSource = neoFluidHc ? 'NEO' : plannedFluidHc ? 'planned' : 'ZoneRA slots';
  const rosterGroups = Array.isArray(rosterPayload.groups) ? rosterPayload.groups : [];

  const ROSTER_LABEL = { 'WEST-DOORS': 'West Doors', 'EAST-DOORS': 'East Doors', 'FLOATER': 'Floater' };

  setText('obCalc', fmt(ob));
  setText('divertGap', (gap >= 0 ? '+' : '') + fmt(gap), colorClass(gap));
  setText('avgCaptureRate', fmt(avgCapture, 2));
  setText('avgRequiredJplh', fmt(avgReqJplh, 2));
  if (rosterGroups.length) {
    const groupHtml = rosterGroups.map((group) => {
      const g = num(group.current) - num(group.target);
      const cls = g >= 0 ? 'good' : g < -(num(group.target) * 0.1) ? 'bad' : 'warn';
      const label = ROSTER_LABEL[group.label] || group.label;
      return `<div class="roster-group-row ${cls}"><span class="roster-group-label">${label}</span><span class="roster-group-count"><b>${fmt(group.current)}</b>/${fmt(group.target)}</span><span class="roster-group-gap">(${signed(g)})</span></div>`;
    }).join('');
    setHtml('fluidRosterBreakdown', groupHtml);
    const recoEl = $('fluidRosterRecommendation');
    if (recoEl) {
      const reco = fluidRosterBalanceReco(rosterGroups);
      if (reco) {
        recoEl.textContent = reco.text;
        recoEl.className = `goal-card-status ${reco.tone}`;
        recoEl.style.display = '';
      } else {
        recoEl.style.display = 'none';
      }
    }
  } else {
    setText('fluidRosterBreakdown', 'ZoneRA HC breakdown pending.', 'warn');
    const recoEl = $('fluidRosterRecommendation');
    if (recoEl) recoEl.style.display = 'none';
  }
  if (rosterGroups.length) {
    const slotTotal = rosterGroups.reduce((s, g) => s + num(g.target), 0);
    const slotDetail = rosterGroups.map((g) => `${ROSTER_LABEL[g.label] || g.label} ${fmt(num(g.target))}`).join(' + ');
    setText('fluidHcDifference', `Zone slots: ${slotDetail} = ${fmt(slotTotal)} total capacity.`, '');
  } else if (!neoFluidHc) {
    setText('fluidHcDifference', 'HC difference vs NEO pending.', 'warn');
  } else {
    setText('fluidHcDifference', `NEO actual HC: ${fmt(neoFluidHc)} needed today.`, '');
  }
  if (!compareTarget || !rosterFluidHc) {
    setText('fluidRosterStatus', 'Open roster and enter Fluid HC to compare.', 'warn');
  } else if (rosterGap > 0) {
    setText('fluidRosterStatus', `Over HC by ${fmt(rosterGap)} (${fmt(rosterFluidHc)} fulfilled vs ${fmt(compareTarget)} ${rosterSource}).`, 'warn');
  } else if (rosterGap < 0) {
    setText('fluidRosterStatus', `Below HC by ${fmt(Math.abs(rosterGap))} (${fmt(rosterFluidHc)} fulfilled vs ${fmt(compareTarget)} ${rosterSource}).`, 'bad');
  } else {
    setText('fluidRosterStatus', `At HC (${fmt(rosterFluidHc)} fulfilled vs ${fmt(compareTarget)} ${rosterSource}).`, 'good');
  }
}

function fluidRosterHcSummary() {
  const plannedFluidHc = val('fluidHC');
  const rosterFluidHc = val('rosterFluidHC');
  const rosterTarget = num(latestBridgePayload?.roster?.fluid?.target);
  const neoFluidHc = num(latestBridgePayload?.neo?.fluidLoadHC);
  const compareTarget = neoFluidHc || plannedFluidHc || rosterTarget;
  const rosterSource = neoFluidHc ? 'NEO' : plannedFluidHc ? 'planned' : 'ZoneRA slots';
  if (!compareTarget || !rosterFluidHc) return 'Fluid roster HC: not entered';
  const rosterGap = rosterFluidHc - compareTarget;
  const plannedGap = '';
  if (rosterGap > 0) return `Fluid roster HC: over by ${fmt(rosterGap)} (${fmt(rosterFluidHc)} fulfilled vs ${fmt(compareTarget)} ${rosterSource})${plannedGap}`;
  if (rosterGap < 0) return `Fluid roster HC: below by ${fmt(Math.abs(rosterGap))} (${fmt(rosterFluidHc)} fulfilled vs ${fmt(compareTarget)} ${rosterSource})${plannedGap}`;
  return `Fluid roster HC: at plan (${fmt(rosterFluidHc)} fulfilled vs ${fmt(compareTarget)} ${rosterSource})${plannedGap}`;
}

function renderFullShiftJplh(rows) {
  const periodTotes = rows.reduce((s, p) => s + val(`${p.key}_totes`), 0);
  const periodCases = rows.reduce((s, p) => s + val(`${p.key}_cases`), 0);
  const periodJobs = rows.reduce((s, p) => s + (val(`${p.key}_jobs`) || (val(`${p.key}_totes`) + val(`${p.key}_cases`))), 0);
  const periodWB = rows.reduce((s, p) => s + val(`${p.key}_wb`), 0);

  let fullTotes = val('fullTotes');
  let fullCases = val('fullCases');
  let fullJobs = val('fullJobs');
  let fullWB = val('fullWB');
  let source = 'full shift inputs';

  if (!fullTotes && !fullCases && !fullJobs && !fullWB) {
    fullTotes = periodTotes;
    fullCases = periodCases;
    fullJobs = periodJobs;
    fullWB = periodWB;
    source = 'period totals fallback';
    setVal('fullTotes', fullTotes);
    setVal('fullCases', fullCases);
    setVal('fullJobs', fullJobs);
    setVal('fullWB', fullWB, 2);
  }

  if (!fullJobs && (fullTotes || fullCases)) {
    fullJobs = fullTotes + fullCases;
    setVal('fullJobs', fullJobs);
  }

  const totalHours = rows.reduce((s, p) => s + effectivePeriodHours(p), 0);
  const fluidGoal = rows.reduce((s, p) => s + p.fl, 0);
  const captureTarget = rows.reduce((s, p) => s + p.total, 0);
  const actualJplh = fullWB > 0 ? fullJobs / fullWB : 0;
  const requiredJplh = (val('fluidHC') * totalHours) > 0 ? fluidGoal / (val('fluidHC') * totalHours) : val('fluidRate');
  const gap = actualJplh - requiredJplh;

  setText('fullActualJplh', fmt(actualJplh, 2));
  setText('fullRequiredJplh', fmt(requiredJplh, 2));
  setText('fullJplhGap', (gap >= 0 ? '+' : '') + fmt(gap, 2), colorClass(gap));
  setText('fullCaptureTarget', fmt(captureTarget));
  setText('fullSource', source);

  return { fullTotes, fullCases, fullJobs, fullWB, actualJplh, requiredJplh, gap, captureTarget, fluidGoal, source };
}

function renderBoard(rows) {
  let remFl = val('goalFluid');
  let remMp = val('goalMp');
  let remRwc = val('goalRwc');
  const lines = [];
  const fullFlUtil = monitorFullFlUtil();

  for (const p of PERIODS) {
    const isActive = rows.some((r) => r.key === p.key);
    document.querySelectorAll(`[data-period-row="${p.key}"]`).forEach((row) => {
      row.style.display = isActive ? '' : 'none';
    });
  }

  rows.forEach((p) => {
    const pHours = effectivePeriodHours(p);
    const remainingHoursAfterPeriod = rows
      .filter((row) => rows.indexOf(row) > rows.indexOf(p))
      .reduce((s, row) => s + effectivePeriodHours(row), 0);
    const totes = val(`${p.key}_totes`);
    const cases = val(`${p.key}_cases`);
    const jobs = val(`${p.key}_jobs`) || (totes + cases);
    const wb = val(`${p.key}_wb`);
    const jplh = wb > 0 ? jobs / wb : 0;
    const reqJplh = (val('fluidHC') * pHours) > 0 ? p.fl / (val('fluidHC') * pHours) : val('fluidRate');
    const jGap = jplh - reqJplh;

    const fl = val(`${p.key}_flu_fl`);
    const mp = val(`${p.key}_flu_mp`);
    const rwc = val(`${p.key}_flu_rwc`);
    const flUtilCapture = fl + mp + rwc;
    const capture = periodActualCapture(p.key);
    const captureGap = capture - p.total;

    const east = val(`${p.key}_belt_east`);
    const west = val(`${p.key}_belt_west`);
    const belt = east + west;
    const beltGap = belt - p.fl;

    remFl -= fl;
    remMp -= mp;
    remRwc -= rwc;
    const remain = remFl + remMp + remRwc;
    const nextNeedHr = remainingHoursAfterPeriod > 0 ? remain / remainingHoursAfterPeriod : remain;

    setText(`${p.key}_hours`, fmt(pHours, 1));
    setText(`${p.key}_g_fl`, fmt(p.fl));
    setText(`${p.key}_g_mp`, fmt(p.mp));
    setText(`${p.key}_g_rwc`, fmt(p.rwc));
    setText(`${p.key}_g_total`, fmt(p.total));

    setText(`${p.key}_jplh`, fmt(jplh, 2));
    setText(`${p.key}_req_jplh`, fmt(reqJplh, 2));
    setText(`${p.key}_jplh_gap`, (jGap >= 0 ? '+' : '') + fmt(jGap, 2), colorClass(jGap));

    setText(`${p.key}_capture_fclm`, fmt(jobs));
    setText(`${p.key}_capture_fl_util`, fmt(flUtilCapture));
    setText(`${p.key}_capture`, fmt(capture));
    setText(`${p.key}_capture_gap`, (captureGap >= 0 ? '+' : '') + fmt(captureGap), colorClass(captureGap));
    setText(`${p.key}_fl_remain`, fmt(remFl), remFl <= 0 ? 'good' : 'warn');
    setText(`${p.key}_remain_total`, fmt(remain), remain <= 0 ? 'good' : 'warn');
    setText(`${p.key}_ob_need_hr`, fmt(nextNeedHr, 2), remain <= 0 ? 'good' : 'warn');

    setText(`${p.key}_belt_total`, fmt(belt));
    setText(`${p.key}_belt_gap`, (beltGap >= 0 ? '+' : '') + fmt(beltGap), colorClass(beltGap));

    const note = ($(`${p.key}_notes`)?.value || '').trim();
    lines.push(`${p.label}: supposed to hit FL ${fmt(p.fl)} and OB ${fmt(p.total)}. Captured ${fmt(capture)} vs OB target ${fmt(p.total)} (${(captureGap >= 0 ? '+' : '') + fmt(captureGap)}). Remaining after period: FL ${fmt(remFl)}, OB ${fmt(remain)}. JPLH ${fmt(jplh, 2)} vs req ${fmt(reqJplh, 2)} (${(jGap >= 0 ? '+' : '') + fmt(jGap, 2)}), belt ${fmt(belt)} vs fluid goal ${fmt(p.fl)} (${(beltGap >= 0 ? '+' : '') + fmt(beltGap)}).${note ? ` Notes: ${note}` : ''}`);
  });

  const remainingHours = rows.reduce((s, p) => s + effectivePeriodHours(p), 0);
  const eos = {
    hours: rows.reduce((s, p) => s + effectivePeriodHours(p), 0),
    flGoal: rows.reduce((s, p) => s + p.fl, 0),
    mpGoal: rows.reduce((s, p) => s + p.mp, 0),
    rwcGoal: rows.reduce((s, p) => s + p.rwc, 0),
    obGoal: rows.reduce((s, p) => s + p.total, 0),
    totes: rows.reduce((s, p) => s + val(`${p.key}_totes`), 0),
    cases: rows.reduce((s, p) => s + val(`${p.key}_cases`), 0),
    jobs: rows.reduce((s, p) => s + (val(`${p.key}_jobs`) || (val(`${p.key}_totes`) + val(`${p.key}_cases`))), 0),
    wb: rows.reduce((s, p) => s + val(`${p.key}_wb`), 0),
    fl: rows.reduce((s, p) => s + val(`${p.key}_flu_fl`), 0),
    mp: rows.reduce((s, p) => s + val(`${p.key}_flu_mp`), 0),
    rwc: rows.reduce((s, p) => s + val(`${p.key}_flu_rwc`), 0),
    east: rows.reduce((s, p) => s + val(`${p.key}_belt_east`), 0),
    west: rows.reduce((s, p) => s + val(`${p.key}_belt_west`), 0),
    flRemain: remFl,
    mpRemain: remMp,
    rwcRemain: remRwc,
    remain: remFl + remMp + remRwc,
    periodCaptures: rows.map((p) => ({
      label: p.label,
      value: periodActualCapture(p.key)
    })),
    fclmCapture: rows.reduce((s, p) => s + periodFclmJobs(p.key), 0),
    flUtilCapture: rows.reduce((s, p) => s + periodFlUtilCapture(p.key), 0)
  };
  eos.jplh = eos.wb > 0 ? eos.jobs / eos.wb : 0;
  eos.reqJplh = (val('fluidHC') * eos.hours) > 0 ? eos.flGoal / (val('fluidHC') * eos.hours) : val('fluidRate');
  eos.jGap = eos.jplh - eos.reqJplh;
  const periodCaptureTotal = eos.periodCaptures.reduce((sum, item) => sum + item.value, 0);
  const useFullFlUtil = fullFlUtil && (periodCaptureTotal <= 0 || fullFlUtil.total >= periodCaptureTotal * 0.5);
  if (useFullFlUtil) {
    eos.fl = fullFlUtil.fl;
    eos.mp = fullFlUtil.mp;
    eos.rwc = fullFlUtil.rwc;
    eos.flUtilCapture = fullFlUtil.total;
    eos.flRemain = eos.flGoal - eos.fl;
    eos.mpRemain = eos.mpGoal - eos.mp;
    eos.rwcRemain = eos.rwcGoal - eos.rwc;
    eos.remain = eos.flRemain + eos.mpRemain + eos.rwcRemain;
  }
  eos.capture = useFullFlUtil ? fullFlUtil.total : periodCaptureTotal;
  eos.captureGap = eos.capture - eos.obGoal;
  eos.belt = eos.east + eos.west;
  eos.beltGap = eos.belt - eos.flGoal;
  eos.obNeedHr = eos.remain > 0 && remainingHours > 0 ? eos.remain / remainingHours : 0;

  setText('eos_hours', fmt(eos.hours, 1));
  setText('eos_g_fl', fmt(eos.flGoal));
  setText('eos_g_mp', fmt(eos.mpGoal));
  setText('eos_g_rwc', fmt(eos.rwcGoal));
  setText('eos_g_total', fmt(eos.obGoal));
  setText('eos_totes', fmt(eos.totes));
  setText('eos_cases', fmt(eos.cases));
  setText('eos_jobs', fmt(eos.jobs));
  setText('eos_wb', fmt(eos.wb, 2));
  setText('eos_jplh', fmt(eos.jplh, 2));
  setText('eos_req_jplh', fmt(eos.reqJplh, 2));
  setText('eos_jplh_gap', (eos.jGap >= 0 ? '+' : '') + fmt(eos.jGap, 2), colorClass(eos.jGap));
  setText('eos_capture_fclm', fmt(eos.fclmCapture));
  setText('eos_capture_fl_util', fmt(eos.flUtilCapture));
  setText('eos_flu_fl', fmt(eos.fl));
  setText('eos_flu_mp', fmt(eos.mp));
  setText('eos_flu_rwc', fmt(eos.rwc));
  setText('eos_capture', fmt(eos.capture));
  setText('eos_capture_gap', (eos.captureGap >= 0 ? '+' : '') + fmt(eos.captureGap), colorClass(eos.captureGap));
  setText('eos_fl_remain', fmt(eos.flRemain), eos.flRemain <= 0 ? 'good' : 'warn');
  setText('eos_remain_total', fmt(eos.remain), eos.remain <= 0 ? 'good' : 'warn');
  setText('eos_ob_need_hr', fmt(eos.obNeedHr, 2), eos.remain <= 0 ? 'good' : 'warn');
  setText('eos_belt_east', fmt(eos.east));
  setText('eos_belt_west', fmt(eos.west));
  setText('eos_belt_total', fmt(eos.belt));
  setText('eos_belt_gap', (eos.beltGap >= 0 ? '+' : '') + fmt(eos.beltGap), colorClass(eos.beltGap));

  return { lines, eos };
}

function renderPieChart(chartId, legendId, items) {
  const chart = $(chartId);
  const legend = $(legendId);
  if (!chart || !legend) return;

  const colors = ['#173cff', '#00f12a', '#ff00e6', '#facc15', '#38bdf8', '#fb7185'];
  const clean = items
    .map((item, i) => ({ ...item, color: item.color || colors[i % colors.length], value: Math.max(0, num(item.value)) }))
    .filter((item) => item.value > 0);
  const total = clean.reduce((s, item) => s + item.value, 0);

  if (!total) {
    chart.style.background = 'conic-gradient(var(--line) 0 360deg)';
    legend.innerHTML = '<div class="legend-row"><span class="swatch" style="background:var(--line)"></span><span>No data yet</span><span>0</span></div>';
    return;
  }

  let cursor = 0;
  const stops = clean.map((item) => {
    const start = cursor;
    const end = cursor + item.value / total * 360;
    cursor = end;
    return `${item.color} ${start}deg ${end}deg`;
  });

  chart.style.background = `conic-gradient(${stops.join(',')})`;
  legend.innerHTML = clean.map((item) => {
    const percentage = clamp(item.value / total * 100, 0, 100);
    return `
      <div class="legend-row">
        <span class="swatch" style="background:${item.color}"></span>
        <span>${item.label}</span>
        <span>${fmt(item.value)} (${fmt(percentage, 1)}%)</span>
      </div>
    `;
  }).join('');
}

function periodMetrics(rows) {
  let remFl = val('goalFluid');
  let remMp = val('goalMp');
  let remRwc = val('goalRwc');

  return rows.map((p, index) => {
    const fl = val(`${p.key}_flu_fl`);
    const mp = val(`${p.key}_flu_mp`);
    const rwc = val(`${p.key}_flu_rwc`);
    const capture = periodActualCapture(p.key);
    const east = val(`${p.key}_belt_east`);
    const west = val(`${p.key}_belt_west`);
    const belt = east + west;
    const totes = val(`${p.key}_totes`);
    const cases = val(`${p.key}_cases`);
    const jobs = val(`${p.key}_jobs`) || (totes + cases);
    const wb = val(`${p.key}_wb`);
    const jplh = wb > 0 ? jobs / wb : 0;
    const activeHours = effectivePeriodHours(p);
    const reqJplh = (val('fluidHC') * activeHours) > 0 ? p.fl / (val('fluidHC') * activeHours) : val('fluidRate');

    remFl -= fl;
    remMp -= mp;
    remRwc -= rwc;

    const remain = remFl + remMp + remRwc;
    const remainingHoursAfterPeriod = rows
      .slice(index + 1)
      .reduce((s, row) => s + effectivePeriodHours(row), 0);

    return {
      ...p,
      actualFl: fl,
      actualMp: mp,
      actualRwc: rwc,
      activeHours,
      capture,
      flUtilCapture: fl + mp + rwc,
      fclmJobs: jobs,
      captureGap: capture - p.total,
      flRemain: remFl,
      obRemain: remain,
      nextNeedHr: remainingHoursAfterPeriod > 0 ? remain / remainingHoursAfterPeriod : remain,
      east,
      west,
      belt,
      beltGap: belt - p.fl,
      jobs,
      wb,
      jplh,
      reqJplh,
      jplhGap: jplh - reqJplh
    };
  });
}

function renderBoardBreakout(rows, board) {
  const wrap = $('periodBreakout');
  if (!wrap) return;

  const data = periodMetrics(rows);
  const rowHtml = (items, cells) => items.map((item) => `<tr>${cells(item)}</tr>`).join('');

  wrap.innerHTML = `
    <details class="collapse-card" open>
      <summary>Plan + JPLH</summary>
      <table class="mini-table">
        <thead>
          <tr><th>Period</th><th class="num">FL Hit</th><th class="num">MP Hit</th><th class="num">RWC Hit</th><th class="num">OB Hit</th><th class="num">JPLH</th></tr>
        </thead>
        <tbody>
          ${rowHtml(data, (p) => `
            <td><b>${p.label}</b></td>
            <td class="num">${fmt(p.fl)}</td>
            <td class="num">${fmt(p.mp)}</td>
            <td class="num">${fmt(p.rwc)}</td>
            <td class="num">${fmt(p.total)}</td>
            <td class="num ${colorClass(p.jplhGap)}">${fmt(p.jplh, 2)} / ${fmt(p.reqJplh, 2)}</td>
          `)}
          <tr class="total-row"><td><b>TOTAL</b></td><td class="num">${fmt(board.eos.flGoal)}</td><td class="num">${fmt(board.eos.mpGoal)}</td><td class="num">${fmt(board.eos.rwcGoal)}</td><td class="num">${fmt(board.eos.obGoal)}</td><td class="num">${fmt(board.eos.jplh, 2)} / ${fmt(board.eos.reqJplh, 2)}</td></tr>
        </tbody>
      </table>
    </details>
    <details class="collapse-card" open>
      <summary>Capture Countdown</summary>
      <table class="mini-table">
        <thead>
          <tr><th>Period</th><th class="num">FCLM</th><th class="num">FL Util</th><th class="num">Actual</th><th class="num">Gap</th><th class="num">FL Left</th><th class="num">OB Left</th><th class="num">Next OB/Hr</th></tr>
        </thead>
        <tbody>
          ${rowHtml(data, (p) => `
            <td><b>${p.label}</b></td>
            <td class="num">${fmt(p.fclmJobs)}</td>
            <td class="num">${fmt(p.flUtilCapture)}</td>
            <td class="num">${fmt(p.capture)}</td>
            <td class="num ${colorClass(p.captureGap)}">${p.captureGap >= 0 ? '+' : ''}${fmt(p.captureGap)}</td>
            <td class="num ${p.flRemain <= 0 ? 'good' : 'warn'}">${fmt(p.flRemain)}</td>
            <td class="num ${p.obRemain <= 0 ? 'good' : 'warn'}">${fmt(p.obRemain)}</td>
            <td class="num ${p.obRemain <= 0 ? 'good' : 'warn'}">${fmt(p.nextNeedHr, 2)}</td>
          `)}
          <tr class="total-row"><td><b>TOTAL</b></td><td class="num">${fmt(board.eos.fclmCapture)}</td><td class="num">${fmt(board.eos.flUtilCapture)}</td><td class="num">${fmt(board.eos.capture)}</td><td class="num ${colorClass(board.eos.captureGap)}">${board.eos.captureGap >= 0 ? '+' : ''}${fmt(board.eos.captureGap)}</td><td class="num">${fmt(board.eos.flRemain)}</td><td class="num">${fmt(board.eos.remain)}</td><td class="num">${fmt(board.eos.obNeedHr, 2)}</td></tr>
        </tbody>
      </table>
    </details>
    <details class="collapse-card" open>
      <summary>Battle of the Belt</summary>
      <table class="mini-table">
        <thead>
          <tr><th>Period</th><th class="num">East</th><th class="num">West</th><th class="num">Total</th><th class="num">Gap vs FL</th></tr>
        </thead>
        <tbody>
          ${rowHtml(data, (p) => `
            <td><b>${p.label}</b></td>
            <td class="num">${fmt(p.east)}</td>
            <td class="num">${fmt(p.west)}</td>
            <td class="num">${fmt(p.belt)}</td>
            <td class="num ${colorClass(p.beltGap)}">${p.beltGap >= 0 ? '+' : ''}${fmt(p.beltGap)}</td>
          `)}
          <tr class="total-row"><td><b>TOTAL</b></td><td class="num">${fmt(board.eos.east)}</td><td class="num">${fmt(board.eos.west)}</td><td class="num">${fmt(board.eos.belt)}</td><td class="num ${colorClass(board.eos.beltGap)}">${board.eos.beltGap >= 0 ? '+' : ''}${fmt(board.eos.beltGap)}</td></tr>
        </tbody>
      </table>
    </details>
  `;
}

function renderPeriodPulse(rows, board) {
  const wrap = $('periodPulse');
  if (!wrap) return;

  const data = periodMetrics(rows);
  const spread = periodSpreadAnalysis(rows);
  const streamRows = [
    {
      key: 'fluid',
      label: 'Fluid',
      cls: 'stream-fluid',
      goal: board.eos.flGoal,
      actual: board.eos.fl,
      left: board.eos.flRemain,
      periods: data.map((p) => ({ label: p.label, goal: p.fl, actual: p.actualFl }))
    },
    {
      key: 'mp',
      label: 'MP',
      cls: 'stream-mp',
      goal: board.eos.mpGoal,
      actual: board.eos.mp,
      left: board.eos.mpRemain,
      periods: data.map((p) => ({ label: p.label, goal: p.mp, actual: p.actualMp }))
    },
    {
      key: 'rwc',
      label: 'RWC',
      cls: 'stream-rwc',
      goal: board.eos.rwcGoal,
      actual: board.eos.rwc,
      left: board.eos.rwcRemain,
      periods: data.map((p) => ({ label: p.label, goal: p.rwc, actual: p.actualRwc }))
    }
  ];
  wrap.innerHTML = `
    <div class="period-pulse-grid">
      ${streamRows.map((stream) => {
        const gap = stream.actual - stream.goal;
        const pct = stream.goal > 0 ? stream.actual / stream.goal * 100 : 0;
        return `
        <article class="period-pulse-card stream-card ${stream.cls}">
          <div class="period-pulse-head">
            <b>${stream.label}</b>
            <span class="${colorClass(gap)}">${gap >= 0 ? '+' : ''}${fmt(gap)}</span>
          </div>
          <div class="period-pulse-metrics">
            <div><span>Goal</span><b>${fmt(stream.goal)}</b></div>
            <div><span>Actual</span><b>${fmt(stream.actual)}</b></div>
            <div><span>Left</span><b class="${stream.left <= 0 ? 'good' : 'warn'}">${fmt(stream.left)}</b></div>
            <div><span>Done</span><b class="${pct >= 100 ? 'good' : 'warn'}">${fmt(pct, 0)}%</b></div>
          </div>
          <div class="period-stream-breakout">
            ${stream.periods.map((p) => `
              <div>
                <span>${p.label}</span>
                <b>${fmt(p.actual)} / ${fmt(p.goal)}</b>
              </div>
            `).join('')}
          </div>
        </article>
      `;
      }).join('')}
      <article class="period-pulse-card total">
        <div class="period-pulse-head">
          <b>OB Total</b>
          <span class="${colorClass(board.eos.captureGap)}">${board.eos.captureGap >= 0 ? '+' : ''}${fmt(board.eos.captureGap)} OB</span>
        </div>
        <div class="period-pulse-metrics">
          <div><span>Goal</span><b>${fmt(board.eos.obGoal)}</b></div>
          <div><span>Actual</span><b>${fmt(board.eos.capture)}</b></div>
          <div><span>Remain</span><b class="${board.eos.remain <= 0 ? 'good' : 'warn'}">${fmt(board.eos.remain)}</b></div>
          <div><span>Belt</span><b>${fmt(board.eos.belt)}</b></div>
        </div>
      </article>
      <article class="period-pulse-card struggle">
        <div class="period-pulse-head">
          <b>Biggest Miss</b>
          <span class="${spread.worstSegment ? colorClass(spread.worstSegment.gap) : ''}">${spread.worstSegment ? signed(spread.worstSegment.gap) : '-'}</span>
        </div>
        <div class="period-pulse-metrics">
          <div><span>Where</span><b>${spread.worstSegment ? `${spread.worstSegment.period} ${spread.worstSegment.label}` : '-'}</b></div>
          <div><span>Result</span><b>${spread.worstSegment ? `${fmt(spread.worstSegment.actual)} / ${fmt(spread.worstSegment.should)}` : '-'}</b></div>
          <div><span>Miss</span><b class="${spread.worstSegment ? colorClass(spread.worstSegment.gap) : ''}">${spread.worstSegment ? signed(spread.worstSegment.gap) : '-'}</b></div>
          <div><span>EOS</span><b>${spread.worstSegment ? 'Callout' : 'Pending'}</b></div>
        </div>
        <div class="period-struggle-note">
          ${spread.worstSegment
            ? `Use this in EOS: ${spread.worstSegment.period} was lightest during ${spread.worstSegment.label}.`
            : 'Enter FL Utilization Actuals and this will identify the weakest handoff window.'}
        </div>
      </article>
    </div>
  `;
}

function isChecked(id) {
  return !!$(id)?.checked;
}

function checklistItem(id, label, autoDone, detail = '') {
  const checked = autoDone || isChecked(id);
  return `
    <label class="check-item ${checked ? 'done' : ''}">
      <input id="${id}" type="checkbox" ${checked ? 'checked' : ''} ${autoDone ? 'data-auto-check="true"' : ''} />
      <span>
        <b>${label}</b>
        ${detail ? `<small>${detail}</small>` : ''}
      </span>
    </label>
  `;
}

function renderPeriodChecklist(rows) {
  const wrap = $('periodChecklist');
  if (!wrap) return;

  wrap.innerHTML = rows.map((p) => {
    const jobs = val(`${p.key}_jobs`) || val(`${p.key}_totes`) + val(`${p.key}_cases`);
    const hasFclm = jobs > 0 || val(`${p.key}_wb`) > 0;
    const capture = periodActualCapture(p.key);
    const flUtilCapture = periodFlUtilCapture(p.key);
    const belt = val(`${p.key}_belt_east`) + val(`${p.key}_belt_west`);
    const hasNotes = ($(`${p.key}_notes`)?.value || '').trim().length > 0;
    return `
      <article class="check-card">
        <div class="check-card-head">
          <b>${p.label}</b>
          <span>${fmt(capture)} Actual | ${fmt(belt)} belt</span>
        </div>
        <div class="check-list">
          ${checklistItem(`${p.key}_check_fclm`, 'FCLM pulled', hasFclm, hasFclm ? `${fmt(jobs)} jobs` : 'waiting on period tab')}
          ${checklistItem(`${p.key}_check_capture`, 'FL Utilization Actual entered', flUtilCapture > 0, flUtilCapture > 0 ? `${fmt(flUtilCapture)} FL Util` : 'waiting on bridge or manual')}
          ${checklistItem(`${p.key}_check_belt`, 'Belt entered', belt > 0, belt > 0 ? `${fmt(belt)} total` : 'east/west pending')}
          ${checklistItem(`${p.key}_check_notes`, 'Notes entered', hasNotes, hasNotes ? 'ready for summary' : 'optional but useful')}
          ${checklistItem(`${p.key}_check_copied`, 'Summary copied', false, 'manual check')}
        </div>
      </article>
    `;
  }).join('');
}

function renderCharts(board) {
  const eos = board.eos;

  renderPieChart('chartFlUtil', 'legendFlUtil', [
    { label: 'TOTAL FL', value: eos.fl, color: '#173cff' },
    { label: 'TOTAL MP', value: eos.mp, color: '#00f12a' },
    { label: 'TOTAL RWC', value: eos.rwc, color: '#ff00e6' }
  ]);

  renderPieChart('chartBelt', 'legendBelt', [
    { label: 'East Side', value: eos.east, color: '#173cff' },
    { label: 'West Side', value: eos.west, color: '#00f12a' }
  ]);

  renderPieChart('chartCapture', 'legendCapture', [
    { label: 'Captured', value: eos.capture, color: '#00f12a' },
    { label: 'Remaining OB', value: Math.max(0, eos.remain), color: '#ff4d5e' }
  ]);
  renderPieChart('chartCaptureOverview', 'legendCaptureOverview', [
    { label: 'Captured', value: eos.capture, color: '#00f12a' },
    { label: 'Remaining OB', value: Math.max(0, eos.remain), color: '#ff4d5e' }
  ]);

  renderPieChart('chartPeriods', 'legendPeriods', eos.periodCaptures.map((p, i) => ({
    label: p.label,
    value: p.value,
    color: ['#173cff', '#00f12a', '#ff00e6', '#facc15'][i]
  })));
}

function periodHourSegments(key) {
  const segments = {
    p1: [
      { label: '19:00 - 20:00', hours: 1, start: [19, 0], end: [20, 0], endOffset: 0 },
      { label: '20:00 - 21:00', hours: 1, start: [20, 0], end: [21, 0], endOffset: 0 },
      { label: '21:00 - 22:00', hours: 1, start: [21, 0], end: [22, 0], endOffset: 0 },
      { label: '22:00 - 23:00', hours: 1, start: [22, 0], end: [23, 0], endOffset: 0 }
    ],
    p2: [
      { label: '23:30 - 00:30', hours: 1, start: [23, 30], end: [0, 30], endOffset: 1 },
      { label: '00:30 - 01:30', hours: 1, start: [0, 30], startOffset: 1, end: [1, 30], endOffset: 1 },
      { label: '01:30 - 02:30', hours: 1, start: [1, 30], startOffset: 1, end: [2, 30], endOffset: 1 }
    ],
    p3: [
      { label: '03:00 - 04:00', hours: 1, start: [3, 0], startOffset: 1, end: [4, 0], endOffset: 1 },
      { label: '04:00 - 05:00', hours: 1, start: [4, 0], startOffset: 1, end: [5, 0], endOffset: 1 },
      { label: '05:00 - 05:30', hours: 0.5, start: [5, 0], startOffset: 1, end: [5, 30], endOffset: 1 }
    ],
    met: [
      { label: '05:30 - 06:30', hours: 1, start: [5, 30], startOffset: 1, end: [6, 30], endOffset: 1 }
    ]
  };
  return segments[key] || [];
}

function shiftBaseDate() {
  const [y, m, d] = ($('shiftDate')?.value || new Date().toISOString().slice(0, 10)).split('-').map(Number);
  return new Date(y, m - 1, d);
}

function segmentDate(base, time, offset = 0) {
  const date = new Date(base);
  date.setDate(date.getDate() + offset);
  date.setHours(time[0], time[1], 0, 0);
  return date;
}

function periodTimedSegments(key) {
  const base = shiftBaseDate();
  const now = new Date();
  let bypassLeft = downtimeHours(key);
  return periodHourSegments(key).map((segment) => {
    const start = segmentDate(base, segment.start, segment.startOffset || 0);
    const end = segmentDate(base, segment.end, segment.endOffset || 0);
    const wallElapsedHours = clamp((now - start) / 3600000, 0, segment.hours);
    const bypassApplied = Math.min(bypassLeft, segment.hours);
    bypassLeft -= bypassApplied;
    const effectiveHours = Math.max(0, segment.hours - bypassApplied);
    const elapsedHours = clamp(wallElapsedHours - bypassApplied, 0, effectiveHours);
    const state = wallElapsedHours <= 0 ? 'future' : wallElapsedHours >= segment.hours ? 'complete' : 'current';
    return { ...segment, startDate: start, endDate: end, elapsedHours, wallElapsedHours, bypassApplied, effectiveHours, state };
  });
}

function splitGoalBySegments(total, segments) {
  const segmentHours = segments.reduce((sum, segment) => sum + (segment.effectiveHours ?? segment.hours), 0);
  let allocated = 0;
  return segments.map((segment, index) => {
    const last = index === segments.length - 1;
    const hours = segment.effectiveHours ?? segment.hours;
    const amount = segmentHours <= 0 ? 0 : last ? Math.round(total - allocated) : Math.round(total * hours / segmentHours);
    allocated += amount;
    return amount;
  });
}

function paceModeConfig(rows, data = periodMetrics(rows)) {
  const fullFlUtil = monitorFullFlUtil();
  const periodCaptureTotal = periodActualCaptureTotal(rows);
  const useFullFlUtilTotal = fullFlUtil && (periodCaptureTotal <= 0 || fullFlUtil.total >= periodCaptureTotal * 0.5);
  const validStreams = ['ob', 'fluid', 'rwc', 'mp'];
  const activeStream = validStreams.includes(localStorage.getItem(PACE_STREAM_KEY))
    ? localStorage.getItem(PACE_STREAM_KEY)
    : 'ob';
  const shipSortGoal = val('shipSortGoal');
  const obGoal = rows.reduce((sum, row) => sum + row.total, 0);
  const metricFor = (row) => data.find((item) => item.key === row.key) || row;
  const streamConfigs = {
    ob: {
      key: 'ob',
      label: 'OB',
      title: 'OB Pace',
      subtitle: 'Projected OB goal from NEO vs Should Hit from Ship Sort Diverts, with Actual from median FL Utilization + FCLM Jobs',
      goal: (row) => row.total,
      should: (row) => obGoal > 0 ? Math.round(shipSortGoal * row.total / obGoal) : row.total,
      actual: (row) => metricFor(row).capture || 0,
      totalActual: useFullFlUtilTotal ? fullFlUtil.total : periodCaptureTotal,
      shouldLabel: 'Ship Sort'
    },
    fluid: {
      key: 'fluid',
      label: 'Fluid',
      title: 'Fluid Pace',
      subtitle: 'Fluid Load Jobs from NEO vs FL Actual from FL Utilization',
      goal: (row) => row.fl,
      should: (row) => row.fl,
      actual: (row) => metricFor(row).actualFl || 0,
      totalActual: fullFlUtil?.fl,
      shouldLabel: 'NEO'
    },
    rwc: {
      key: 'rwc',
      label: 'RWC',
      title: 'RWC Pace',
      subtitle: 'RWC Jobs from NEO vs RWC Actual from FL Utilization',
      goal: (row) => row.rwc,
      should: (row) => row.rwc,
      actual: (row) => metricFor(row).actualRwc || 0,
      totalActual: fullFlUtil?.rwc,
      shouldLabel: 'NEO'
    },
    mp: {
      key: 'mp',
      label: 'MP/DP',
      title: 'MP/DP Pace',
      subtitle: 'Manual Palletize Jobs from NEO vs MP Actual from FL Utilization',
      goal: (row) => row.mp,
      should: (row) => row.mp,
      actual: (row) => metricFor(row).actualMp || 0,
      totalActual: fullFlUtil?.mp,
      shouldLabel: 'NEO'
    }
  };
  return { activeStream, validStreams, streamConfigs, stream: streamConfigs[activeStream] || streamConfigs.ob };
}

function projectionPeriodActual(row, stream) {
  if (!stream) return periodActualCapture(row.key);
  return stream.actual(row);
}

function projectionActualSplit(row, segments, stream = null) {
  const periodActual = projectionPeriodActual(row, stream);
  // Only distribute actual across elapsed segments — future hours stay empty until they happen
  const elapsedEffective = segments.reduce((sum, s) => {
    if (s.state === 'complete') return sum + (s.effectiveHours ?? s.hours);
    if (s.state === 'current') return sum + s.elapsedHours;
    return sum;
  }, 0);
  let allocated = 0;
  return segments.map((segment, index) => {
    const id = `${row.key}_${stream?.key || 'ob'}_proj_actual_${index}`;
    const el = $(id);
    const raw = (el?.value || '').trim();
    if (raw !== '' && el?.dataset.projectionAuto !== 'true') return { id, actual: val(id), manual: true };
    if (segment.state === 'future') return { id, actual: null, manual: false };
    if (periodActual <= 0 || elapsedEffective <= 0) return { id, actual: null, manual: false };
    const segElapsed = segment.state === 'current' ? segment.elapsedHours : (segment.effectiveHours ?? segment.hours);
    // Last elapsed segment absorbs rounding remainder
    const isLastElapsed = segments.slice(index + 1).every(s => s.state === 'future');
    const actual = isLastElapsed
      ? Math.round(periodActual - allocated)
      : Math.round(periodActual * segElapsed / elapsedEffective);
    allocated += actual;
    return { id, actual, manual: false };
  });
}

function periodSpreadAnalysis(rows = plan()) {
  const periodData = periodMetrics(rows);
  const periods = rows.map((row) => {
    const segments = periodTimedSegments(row.key);
    const expected = splitGoalBySegments(row.total, segments);
    const actual = projectionActualSplit(row, segments).map((item) => item.actual);
    const segmentRows = segments.map((segment, index) => {
      const hit = actual[index];
      const should = expected[index];
      const gap = hit == null ? null : hit - should;
      return {
        period: row.label,
        label: segment.label,
        should,
        actual: hit,
        gap
      };
    });
    const metric = periodData.find((item) => item.key === row.key);
    return {
      ...row,
      capture: metric?.capture || 0,
      gap: metric?.captureGap || 0,
      segmentRows
    };
  });
  const startedPeriods = periods.filter((period) => period.capture > 0);
  const worstPeriod = startedPeriods.length
    ? [...startedPeriods].sort((a, b) => a.gap - b.gap)[0]
    : null;
  const worstSegment = periods
    .flatMap((period) => period.segmentRows)
    .filter((segment) => segment.gap != null)
    .sort((a, b) => a.gap - b.gap)[0] || null;
  return { periods, worstPeriod, worstSegment };
}

function formatBridgeAge(timestamp) {
  if (!timestamp) return 'No pull yet';
  const ms = typeof timestamp === 'string' ? Date.parse(timestamp) : num(timestamp);
  if (!ms) return 'No pull yet';
  const minutes = Math.max(0, Math.floor((Date.now() - ms) / 60000));
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function bridgeSourceLabel(source) {
  return BRIDGE_SOURCE_LABELS[source] || source || 'Bridge';
}

function bridgePayloadStatus(data, fallback = 'Bridge imported.') {
  const pull = data?.lastPull;
  if (!pull?.source) return fallback;
  const ageText = pull.updatedAt ? ` (${formatBridgeAge(pull.updatedAt)})` : '';
  return `${bridgeSourceLabel(pull.source)} data refreshed${ageText}.`;
}

function bridgeFreshnessSummary(isMetShift = false) {
  const bridge = latestBridgePayload || readStoredBridgePayload();
  if (!bridge) {
    return {
      tone: 'warn',
      value: 'Waiting',
      sub: isMetShift ? 'Pull NEO, FCLM, or MonitorPortal for MET shift inputs' : 'Pull NEO, FCLM, or MonitorPortal to feed pace'
    };
  }

  const fclmTs = Math.max(
    num(bridge.fclmFull?.updatedAt),
    ...Object.values(bridge.fclmPeriods || {}).map((row) => num(row?.updatedAt))
  );
  const flUtilTs = Math.max(
    num(bridge.monitorFull?.flUtil?.updatedAt),
    ...Object.values(bridge.monitorPeriods || {}).map((row) => num(row?.flUtil?.updatedAt))
  );
  const beltTs = Math.max(
    num(bridge.monitorFull?.belt?.updatedAt),
    ...Object.values(bridge.monitorPeriods || {}).map((row) => num(row?.belt?.updatedAt))
  );
  const monitorTs = Math.max(flUtilTs, beltTs);
  const neoTs = bridge.neo?.updatedAt;
  const timestamps = [fclmTs, monitorTs, neoTs]
    .map((value) => (typeof value === 'string' ? Date.parse(value) : num(value)))
    .filter((value) => value > 0);
  const latest = timestamps.length ? Math.max(...timestamps) : 0;
  const staleMinutes = latest ? (Date.now() - latest) / 60000 : Infinity;
  const tone = staleMinutes <= 15 ? 'good' : staleMinutes <= 60 ? 'warn' : 'bad';
  const parts = [];
  if (fclmTs) parts.push(`FCLM ${formatBridgeAge(fclmTs)}`);
  if (flUtilTs) parts.push(`FL Util ${formatBridgeAge(flUtilTs)}`);
  if (beltTs) parts.push(`Belt ${formatBridgeAge(beltTs)}`);
  if (neoTs) parts.push(`NEO ${formatBridgeAge(neoTs)}`);

  return {
    tone,
    value: latest ? formatBridgeAge(latest) : 'Waiting',
    sub: parts.length
      ? `${parts.join(' | ')}${isMetShift ? ' | MET schedule active' : ''}`
      : isMetShift
        ? 'Run bridge pull to refresh MET pace inputs'
        : 'Run bridge pull to refresh pace inputs'
  };
}

function paceBypassSummary(rows, isMetShift = false) {
  const notes = downtimeNotes(rows);
  const totalMinutes = rows.reduce((sum, row) => sum + downtimeMinutes(row.key), 0);
  const activeHours = rows.reduce((sum, row) => sum + row.hours, 0);
  const effectiveHours = rows.reduce((sum, row) => sum + effectivePeriodHours(row), 0);
  const bypassHours = Math.max(0, activeHours - effectiveHours);

  if (!totalMinutes) {
    return {
      tone: 'good',
      value: 'None',
      sub: isMetShift ? 'Full MET clock active through 06:30' : 'Full shift clock active through 05:30'
    };
  }

  return {
    tone: totalMinutes >= 60 ? 'bad' : 'warn',
    value: formatDowntime(totalMinutes),
    sub: notes.length
      ? notes.join(' | ')
      : `${fmt(bypassHours, 1)}h removed from ${isMetShift ? 'MET' : 'shift'} pace clock`
  };
}

function paceJplhSummary(rows, isMetShift = false) {
  const full = renderFullShiftJplh(rows);
  const tone = full.gap >= 0 ? 'good' : full.gap < -0.25 ? 'bad' : 'warn';
  return {
    tone,
    value: `${fmt(full.actualJplh, 2)}`,
    sub: `Req ${fmt(full.requiredJplh, 2)} | ${signed(full.gap, 2)} gap | ${isMetShift ? 'MET hours included' : 'Regular shift hours'}`
  };
}

function paceNextPeriodPreview(rows, context) {
  const {
    currentWindow,
    nextWindow,
    nextPeriodRow,
    stream,
    isMetShift,
    shiftComplete,
    nextPeriodRate,
    timeText,
    hoursUntil
  } = context;

  if (shiftComplete) {
    return {
      tone: 'good',
      value: isMetShift ? 'MET closed' : 'Shift closed',
      sub: isMetShift ? 'P1 through MET complete | extension ended 06:30' : 'P1 through P3 complete | ended 05:30'
    };
  }

  if (currentWindow && nextWindow && nextPeriodRow) {
    const metTag = isMetShift && nextPeriodRow.key === 'met' ? ' | MET extension window' : '';
    return {
      tone: 'warn',
      value: nextWindow.period,
      sub: `${nextWindow.label} at ${fmt(nextPeriodRate, 0)}/hr | target ${fmt(stream.should(nextPeriodRow))}${metTag}`
    };
  }

  if (nextWindow && nextPeriodRow) {
    const metTag = isMetShift && nextPeriodRow.key === 'met' ? ' | MET extension window' : '';
    return {
      tone: 'warn',
      value: `Next ${nextWindow.period}`,
      sub: `Starts ${timeText(nextWindow.startDate)} | ${fmt(nextPeriodRate, 0)}/hr | ${fmt(hoursUntil, 1)}h away${metTag}`
    };
  }

  return {
    tone: 'good',
    value: currentWindow ? 'Last window' : '-',
    sub: isMetShift ? 'MET schedule loaded | waiting on next clock window' : 'Standard shift schedule loaded'
  };
}

function paceStreamComparison(rows, data = periodMetrics(rows)) {
  const { streamConfigs, activeStream } = paceModeConfig(rows, data);
  return ['ob', 'fluid', 'rwc', 'mp'].map((key) => {
    const config = streamConfigs[key];
    const totals = data.reduce((sum, row) => {
      sum.goal += config.should(row);
      sum.actual += config.actual(row);
      return sum;
    }, { goal: 0, actual: 0 });
    if (config.totalActual != null) totals.actual = config.totalActual;
    const pct = totals.goal > 0 ? totals.actual / totals.goal * 100 : 0;
    const tone = pct >= 100 ? 'good' : pct >= 85 ? 'warn' : totals.actual > 0 ? 'bad' : '';
    return {
      key,
      label: config.label,
      pct,
      actual: totals.actual,
      goal: totals.goal,
      active: key === activeStream,
      tone
    };
  });
}

function renderHourlyProjection(rows) {
  const summary = $('projectionSummary');
  const status = $('projectionStatus');
  const streamCompare = $('projectionStreamCompare');
  const paceStatusSub = $('paceStatusSub');
  const script = $('projectionScript');
  const needs = $('projectionNeeds');
  if (!summary) return;
  const data = periodMetrics(rows);
  const isMetShift = $('useMET')?.value === 'true';
  const { activeStream, validStreams, streamConfigs, stream } = paceModeConfig(rows, data);
  const streamTotals = data.reduce((sum, row) => {
    sum.goal += stream.goal(row);
    sum.should += stream.should(row);
    sum.actual += stream.actual(row);
    sum.hours += row.activeHours;
    return sum;
  }, { goal: 0, should: 0, actual: 0, hours: 0 });
  if (stream.totalActual != null) streamTotals.actual = stream.totalActual;

  if ($('paceTrackerTitle')) {
    $('paceTrackerTitle').textContent = isMetShift ? `MET ${stream.title}` : stream.title;
  }
  if ($('paceTrackerSub')) {
    $('paceTrackerSub').textContent = isMetShift
      ? `${stream.subtitle}, including the MET extension`
      : stream.subtitle;
  }

  const shiftTotal = rows.reduce((sum, row) => sum + stream.should(row), 0);
  if (!shiftTotal) {
    if (status) status.innerHTML = '';
    if (streamCompare) streamCompare.innerHTML = '';
    if (paceStatusSub) {
      paceStatusSub.textContent = isMetShift
        ? 'Load MET goals and FL Utilization Actuals to unlock live pace tiles'
        : 'Load shift goals and FL Utilization Actuals to unlock live pace tiles';
    }
    if (script) script.innerHTML = '';
    if (needs) needs.innerHTML = '';
    summary.innerHTML = '<div class="empty-log">Enter or import FL Utilization Actuals plus shift goals to build the hourly projection.</div>';
    return;
  }

  const totalHours = rows.reduce((sum, row) => sum + effectivePeriodHours(row), 0);
  const avgRate = totalHours > 0 ? shiftTotal / totalHours : 0;
  const allTimedSegments = rows.flatMap((row) => periodTimedSegments(row.key).map((segment) => ({ ...segment, period: row.label })));
  const elapsedShiftHours = allTimedSegments.reduce((sum, segment) => sum + segment.elapsedHours, 0);
  const currentWindow = allTimedSegments.find((segment) => segment.state === 'current');
  const currentPeriodRow = currentWindow ? rows.find((row) => row.label === currentWindow.period) : null;
  const projectionState = {
    expectedToDate: 0,
    actualToDate: 0,
    elapsedHours: 0,
    lastPeriod: '',
    startedRows: 0,
    worstStack: 0,
    periodResults: []
  };

  let cumulativeActual = 0;
  let cumulativeStartedExpected = 0;
  let elapsedStartedHours = 0;
  let accActual = 0;   // realized actual from completed/in-progress periods
  let accElapsed = 0;  // realized elapsed hours from completed/in-progress periods
  // Shift Goal spans the entire table body — compute total row count up front
  const totalShiftRowSpan = rows.reduce((sum, row) => sum + periodHourSegments(row.key).length + 1, 0);
  const tableBody = rows.map((row) => {
    const isFirstPeriod = row === rows[0];
    const segments = periodTimedSegments(row.key);
    const effectiveHours = effectivePeriodHours(row);
    const periodTarget = stream.should(row);
    const rate = effectiveHours > 0 ? periodTarget / effectiveHours : 0;
    const obSplit = segments.map((segment) => Math.round(rate * segment.elapsedHours));
    const actualSplit = projectionActualSplit(row, segments, stream);
    let periodActual = 0;
    let periodStartedExpected = 0;
    let periodHasActual = false;
    let periodElapsedEffective = 0;
    const rowSpanCount = segments.length + 1;

    const segmentRows = segments.map((segment, index) => {
      const actualItem = actualSplit[index];
      const actual = actualItem.actual;
      const hasActual = actual != null;
      const should = obSplit[index];
      const diff = hasActual || should > 0 ? (actual || 0) - should : null;
      let cumulativeDiff = null;
      let projected = null;
      if ((hasActual || should > 0) && segment.state !== 'future') {
        cumulativeActual += actual || 0;
        periodActual += actual || 0;
        cumulativeStartedExpected += should;
        const segmentHours = segment.effectiveHours ?? segment.hours;
        elapsedStartedHours += segmentHours;
        periodElapsedEffective += segmentHours;
        periodStartedExpected += should;
        periodHasActual = true;
        cumulativeDiff = cumulativeActual - cumulativeStartedExpected;
        // Show projected only on the active segment — extrapolates current period to its end
        if (segment.state === 'current' && periodElapsedEffective > 0 && periodActual > 0) {
          projected = Math.round(periodActual / periodElapsedEffective * effectiveHours);
        }
        projectionState.expectedToDate = cumulativeStartedExpected;
        projectionState.actualToDate = cumulativeActual;
        projectionState.elapsedHours = elapsedShiftHours;
        projectionState.lastPeriod = row.label;
        projectionState.startedRows += 1;
        projectionState.worstStack = Math.min(projectionState.worstStack, cumulativeDiff);
      } else if (segment.state === 'future') {
        const segHours = segment.effectiveHours ?? segment.hours;
        if (periodElapsedEffective > 0 && periodActual > 0) {
          // Remaining hours of the active period — project at current period rate
          projected = Math.round(periodActual / periodElapsedEffective * segHours);
        } else if (accElapsed > 0) {
          // Fully future period — recalibrate from shift's realized rate
          projected = Math.round(accActual / accElapsed * segHours);
        }
      }
      const segExpected = rate * (segment.effectiveHours ?? segment.hours);
      const perfClass = diff == null || segment.state === 'future' ? ''
        : diff >= 0 ? 'perf-good'
        : diff < -segExpected * 0.5 ? 'perf-bad'
        : 'perf-warn';
      const stateLabel = segment.state === 'current' ? ` <span class="projection-now">now ${fmt(segment.elapsedHours, 1)}h active</span>` : '';
      const bypassLabel = segment.bypassApplied ? ` <span class="projection-now">${formatDowntime(segment.bypassApplied * 60)} bypass</span>` : '';
      const bypassTag = downtimeMinutes(row.key) ? `<span class="pace-bypass">${formatDowntime(downtimeMinutes(row.key))} bypass</span>` : '';
      const rowClasses = [
        'projection-segment-row',
        `projection-period-${row.key}`,
        `projection-segment-${index + 1}`,
        segment.state === 'current' ? 'is-current' : '',
        segment.state === 'future' ? 'is-future' : '',
        perfClass
      ].filter(Boolean).join(' ');
      return `
        <tr class="${rowClasses}">
          ${index === 0 ? `<td class="projection-period-label" rowspan="${rowSpanCount}"><b>${row.label}</b>${bypassTag}</td>` : ''}
          <td>${segment.label}${stateLabel}${bypassLabel}</td>
          ${index === 0 && isFirstPeriod ? `<td class="num shift-goal-cell" rowspan="${totalShiftRowSpan}">${fmt(streamTotals.goal)}</td>` : ''}
          ${index === 0 ? `<td class="num" rowspan="${rowSpanCount}">${fmt(periodTarget)}</td>` : ''}
          ${index === 0 ? `<td class="num" rowspan="${rowSpanCount}">${fmt(rate, 0)}/hr</td>` : ''}
          <td class="num"><b>${should > 0 ? fmt(should) : ''}</b></td>
          <td class="num">${projected != null ? fmt(projected) : ''}</td>
          <td><input id="${actualItem.id}" class="projection-actual ${actualItem.manual ? '' : 'is-auto'}" value="${hasActual ? fmt(actual) : ''}" placeholder="${stream.label} actual" title="Actual from FL Utilization — fills completed hours as the shift progresses; future hours stay blank until elapsed" ${actualItem.manual ? '' : 'data-projection-auto="true"'} /></td>
          <td class="num ${diff == null ? '' : colorClass(diff)}">${diff == null ? '' : signed(diff)}</td>
        </tr>
      `;
    }).join('');

    // Lock in this period's realized actuals for future period recalibration
    if (periodHasActual) {
      accActual += periodActual;
      accElapsed += periodElapsedEffective;
    }

    const periodDiff = periodHasActual ? periodActual - periodStartedExpected : null;
    const periodProjected = periodElapsedEffective > 0 && periodActual > 0
      ? Math.round(periodActual / periodElapsedEffective * effectiveHours)
      : accElapsed > 0
        ? Math.round(accActual / accElapsed * effectiveHours)
        : null;
    projectionState.periodResults.push({
      label: row.label,
      target: periodTarget,
      expected: periodStartedExpected,
      actual: periodActual,
      gap: periodDiff,
      started: periodHasActual
    });
    const periodReqRate = effectiveHours > 0 ? periodTarget / effectiveHours : 0;
    const elapsedInPeriod = segments.reduce((s, seg) => s + seg.elapsedHours, 0);
    const periodActRate = elapsedInPeriod > 0 && periodActual > 0 ? periodActual / elapsedInPeriod : null;
    const periodPerfClass = periodDiff == null ? '' : periodDiff >= 0 ? 'perf-good' : 'perf-bad';
    const periodSubtotal = `
      <tr class="projection-period-total projection-period-${row.key} ${periodPerfClass}">
        <td><b>Period total</b></td>
        <td class="num">
          <b>${fmt(periodStartedExpected)}</b>
          ${periodReqRate > 0 ? `<br><span class="pace-rate-sub">Req ${fmt(periodReqRate, 0)}/hr</span>` : ''}
        </td>
        <td class="num">${periodProjected != null ? fmt(periodProjected) : '-'}</td>
        <td class="num">
          ${periodHasActual ? `<b>${fmt(periodActual)}</b>` : '-'}
          ${periodActRate != null ? `<br><span class="pace-rate-sub">Act ${fmt(periodActRate, 0)}/hr</span>` : ''}
        </td>
        <td class="num ${periodDiff == null ? '' : colorClass(periodDiff)}">${periodDiff == null ? '-' : signed(periodDiff)}</td>
      </tr>
    `;
    return segmentRows + periodSubtotal;
  }).join('');

  const grandTotalRow = `
    <tr class="projection-grand-total total-row">
      <td colspan="2"><b>Total So Far</b></td>
      <td class="num"><b>${fmt(streamTotals.goal)}</b></td>
      <td class="num"><b>${fmt(shiftTotal)}</b></td>
      <td class="num"><b>${totalHours > 0 ? fmt(avgRate, 0) : '0'}/hr</b></td>
      <td class="num"><b>${fmt(projectionState.expectedToDate)}</b></td>
      <td class="num"><b>${projectionState.elapsedHours > 0 && projectionState.actualToDate > 0 ? fmt(projectionState.actualToDate / projectionState.elapsedHours * totalHours) : '-'}</b></td>
      <td class="num"><b>${fmt(projectionState.actualToDate)}</b></td>
      <td class="num ${colorClass(projectionState.actualToDate - projectionState.expectedToDate)}"><b>${signed(projectionState.actualToDate - projectionState.expectedToDate)}</b></td>
    </tr>
  `;

  summary.innerHTML = `
    <div class="pace-board-grid">
      <section class="pace-board pace-board-hero">
        <div class="pace-stream-tabs" role="tablist" aria-label="Pace tracker mode">
          ${validStreams.map((key) => `
            <button class="pace-stream-tab ${key === activeStream ? 'active' : ''}" type="button" data-pace-stream="${key}">${streamConfigs[key].label}</button>
          `).join('')}
        </div>
        <div class="pace-board-head">
          <h3>${stream.title}</h3>
          <span>${isMetShift ? `${stream.subtitle}, including the MET extension` : stream.subtitle}</span>
        </div>
        <div class="table-wrap projection-table-wrap">
          <table class="mini-table pace-merged-table projection-table">
            <thead>
              <tr>
                <th>Period</th>
                <th>Time</th>
                <th class="num">Shift Goal</th>
                <th class="num">Goal Per Period<br><span>${stream.shouldLabel}</span></th>
                <th class="num">Plan Rate</th>
                <th class="num">Planned</th>
                <th class="num">Projected</th>
                <th class="num">Actual</th>
                <th class="num">Difference</th>
              </tr>
            </thead>
            <tbody>${tableBody}${grandTotalRow}</tbody>
          </table>
        </div>
      </section>
    </div>
  `;

  const struggling = projectionState.periodResults
    .filter((item) => item.started)
    .sort((a, b) => num(a.gap) - num(b.gap))[0];
  const currentPeriodResult = currentWindow
    ? projectionState.periodResults.find((item) => item.label === currentWindow.period)
    : null;
  const currentPeriodSegments = currentPeriodRow ? periodTimedSegments(currentPeriodRow.key) : [];
  const currentPeriodElapsedHours = currentPeriodSegments.reduce((sum, segment) => sum + segment.elapsedHours, 0);
  const currentPeriodEffectiveHours = currentPeriodRow ? effectivePeriodHours(currentPeriodRow) : 0;
  const currentPeriodRemainingHours = currentPeriodRow ? Math.max(0, currentPeriodEffectiveHours - currentPeriodElapsedHours) : 0;
  const currentPeriodLeft = currentPeriodRow && currentPeriodResult ? Math.max(0, stream.should(currentPeriodRow) - currentPeriodResult.actual) : 0;
  const currentPeriodRecoveryRate = currentPeriodRemainingHours > 0 ? currentPeriodLeft / currentPeriodRemainingHours : 0;
  const closedPeriods = projectionState.periodResults.filter((item) => {
    const row = rows.find((period) => period.label === item.label);
    if (!row) return false;
    return periodTimedSegments(row.key).every((segment) => segment.state === 'complete');
  });

  const remainingGoal = Math.max(0, shiftTotal - projectionState.actualToDate);
  const remainingHours = Math.max(0, totalHours - projectionState.elapsedHours);
  const catchUpRate = remainingHours > 0 ? remainingGoal / remainingHours : 0;
  const currentGap = projectionState.actualToDate - projectionState.expectedToDate;
  const projectedFinish = projectionState.elapsedHours > 0 ? projectionState.actualToDate / projectionState.elapsedHours * totalHours : 0;
  const projectedGap = projectedFinish - shiftTotal;
  const capturePct = shiftTotal > 0 ? projectionState.actualToDate / shiftTotal * 100 : 0;
  const clockPct = totalHours > 0 ? projectionState.elapsedHours / totalHours * 100 : 0;
  const progressGap = capturePct - clockPct;
  const progressTone = !projectionState.startedRows && !shiftComplete
    ? 'warn'
    : progressGap >= 5
      ? 'good'
      : progressGap >= -10
        ? 'warn'
        : 'bad';
  const progressValue = projectionState.startedRows || shiftComplete ? `${fmt(capturePct, 1)}%` : '-';
  const progressSub = projectionState.startedRows || shiftComplete
    ? `${fmt(projectionState.actualToDate)} / ${fmt(shiftTotal)} | ${fmt(remainingGoal)} left`
    : `${fmt(shiftTotal)} ${stream.label} goal loaded`;
  const tone = currentGap < -avgRate * 0.5 ? 'bad' : currentGap < -avgRate * 0.25 ? 'warn' : 'good';
  const paceLabel = currentGap >= avgRate * 0.15 ? 'Ahead' : currentGap >= -avgRate * 0.15 ? 'On Track' : currentGap >= -avgRate * 0.5 ? 'Behind' : 'Critical';
  const paceTone = paceLabel === 'Ahead' || paceLabel === 'On Track' ? 'good' : paceLabel === 'Behind' ? 'warn' : 'bad';
  const nextWindow = allTimedSegments.find((segment) => segment.state === 'future');
  const lastWindow = [...allTimedSegments].reverse().find((segment) => segment.state === 'complete');
  const shiftComplete = allTimedSegments.length > 0 && allTimedSegments.every((segment) => segment.state === 'complete');
  const timeText = (date) => date
    ? date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
    : '';
  const hoursUntil = nextWindow ? Math.max(0, (nextWindow.startDate - new Date()) / 3600000) : 0;
  const nextPeriodRow = nextWindow ? rows.find((row) => row.label === nextWindow.period) : null;
  const nextPeriodEffectiveHours = nextPeriodRow ? effectivePeriodHours(nextPeriodRow) : 0;
  const nextPeriodRate = nextPeriodRow && nextPeriodEffectiveHours > 0 ? stream.should(nextPeriodRow) / nextPeriodEffectiveHours : 0;
  const clockValue = currentWindow
    ? currentWindow.period
    : nextWindow
      ? `Next ${nextWindow.period}`
      : shiftComplete
        ? 'Shift Complete'
        : 'Between Windows';
  const clockSub = currentWindow
    ? `${currentWindow.label} | ${fmt(currentWindow.elapsedHours, 1)}h elapsed`
    : nextWindow
      ? `${nextWindow.label} starts ${timeText(nextWindow.startDate)} | ${fmt(hoursUntil, 1)}h away`
      : shiftComplete
        ? `Ended ${timeText(lastWindow?.endDate)}${isMetShift ? ' with MET included' : ''}`
        : `${isMetShift ? 'MET shift enabled' : 'Standard shift'} | Next shift date may need updating`;
  const periodNeedValue = currentPeriodRow
    ? `${fmt(currentPeriodRecoveryRate, 0)}/hr`
    : nextPeriodRow
      ? `${fmt(nextPeriodRate, 0)}/hr`
      : shiftComplete
        ? 'Done'
        : `${fmt(avgRate, 0)}/hr`;
  const periodNeedSub = currentPeriodRow
    ? `${fmt(currentPeriodLeft)} left in ${currentWindow.period} | ${fmt(currentPeriodRemainingHours, 1)} hrs left`
    : nextPeriodRow
      ? `${nextWindow.period} planned rate | ${fmt(stream.should(nextPeriodRow))} target`
      : shiftComplete
        ? `${fmt(projectionState.actualToDate)} captured vs ${fmt(shiftTotal)} goal`
        : `${isMetShift ? 'MET included' : 'Standard shift'} plan rate`;
  const metRow = rows.find((row) => row.key === 'met');
  const metResult = projectionState.periodResults.find((item) => item.label === 'MET');
  const metLeft = metRow ? Math.max(0, metRow.total - (metResult?.actual || 0)) : 0;
  const statusLabels = isMetShift
    ? {
        pace: 'MET pace status',
        clock: 'MET clock window',
        need: currentPeriodRow?.key === 'met' ? 'MET needs' : 'Active / next needs',
        catchup: 'Extension catch-up',
        projected: 'Projected MET finish',
        struggling: 'Priority period',
        progress: 'MET goal progress',
        jplh: 'Shift JPLH',
        bypass: 'Bypass / downtime',
        next: 'Upcoming window',
        fresh: 'Bridge freshness'
      }
    : {
        pace: 'Pace status',
        clock: 'Clock window',
        need: 'This period needs',
        catchup: 'Catch-up rate',
        projected: 'Projected finish',
        struggling: 'Struggling most',
        progress: 'Shift goal progress',
        jplh: 'Shift JPLH',
        bypass: 'Bypass / downtime',
        next: 'Next period preview',
        fresh: 'Bridge freshness'
      };
  const jplhCard = paceJplhSummary(rows, isMetShift);
  const bypassCard = paceBypassSummary(rows, isMetShift);
  const nextCard = paceNextPeriodPreview(rows, {
    currentWindow,
    nextWindow,
    nextPeriodRow,
    stream,
    isMetShift,
    shiftComplete,
    nextPeriodRate,
    timeText,
    hoursUntil
  });
  const freshCard = bridgeFreshnessSummary(isMetShift);
  const streamCards = paceStreamComparison(rows, data);
  if (paceStatusSub) {
    paceStatusSub.textContent = isMetShift
      ? `Live MET pace for ${stream.label} | extension through 06:30`
      : `Live shift pace for ${stream.label} | standard shift through 05:30`;
  }
  if (streamCompare) {
    streamCompare.innerHTML = `
      <div class="projection-section-title">${isMetShift ? 'MET stream capture mix' : 'Stream capture mix'}</div>
      <div class="projection-stream-grid">
        ${streamCards.map((item) => `
          <article class="projection-stream-chip ${item.active ? 'active' : ''} ${item.tone}">
            <span class="projection-stream-label">${item.label}${item.active ? ' · active tab' : ''}</span>
            <b class="projection-stream-value">${item.goal > 0 ? `${fmt(item.pct, 1)}%` : '-'}</b>
            <small class="projection-stream-sub">${fmt(item.actual)} / ${fmt(item.goal)}</small>
          </article>
        `).join('')}
      </div>
    `;
  }
  if (status) {
    status.innerHTML = `
      ${isMetShift ? `
        <div class="projection-status-card met-mode">
          <div class="projection-status-label">Shift mode</div>
          <div class="projection-status-value">MET</div>
          <div class="projection-status-sub">Extended to 06:30 | MET goal ${fmt(metRow?.total || 0)}${metRow ? ` | left ${fmt(metLeft)}` : ''}</div>
        </div>
      ` : ''}
      <div class="projection-status-card ${paceTone}">
        <div class="projection-status-label">${statusLabels.pace}</div>
        <div class="projection-status-value">${paceLabel}</div>
        <div class="projection-status-sub">${projectionState.startedRows ? `${signed(currentGap)} vs clock target` : 'Waiting for FL Utilization Actual'}</div>
      </div>
      <div class="projection-status-card ${currentWindow ? 'warn' : 'good'}">
        <div class="projection-status-label">${statusLabels.clock}</div>
        <div class="projection-status-value">${clockValue}</div>
        <div class="projection-status-sub">${clockSub}</div>
      </div>
      <div class="projection-status-card ${currentPeriodResult && currentPeriodResult.gap < -avgRate * 0.5 ? 'bad' : currentPeriodResult && currentPeriodResult.gap < -avgRate * 0.25 ? 'warn' : 'good'}">
        <div class="projection-status-label">${statusLabels.need}</div>
        <div class="projection-status-value">${periodNeedValue}</div>
        <div class="projection-status-sub">${periodNeedSub}</div>
      </div>
      <div class="projection-status-card ${tone}">
        <div class="projection-status-label">${statusLabels.catchup}</div>
        <div class="projection-status-value">${fmt(catchUpRate, 0)}/hr</div>
        <div class="projection-status-sub">${projectionState.startedRows ? `${signed(currentGap)} vs expected so far | ${fmt(remainingHours, 1)} hrs left` : `Plan rate is ${fmt(avgRate, 0)}/hr`}</div>
      </div>
      <div class="projection-status-card ${projectedGap >= 0 ? 'good' : projectedGap < -avgRate * 0.5 ? 'bad' : 'warn'}">
        <div class="projection-status-label">${statusLabels.projected}</div>
        <div class="projection-status-value">${projectionState.elapsedHours > 0 ? fmt(projectedFinish) : '-'}</div>
        <div class="projection-status-sub">${projectionState.elapsedHours > 0 ? `${signed(projectedGap)} vs ${isMetShift ? 'MET' : 'shift'} goal if pace holds` : 'Waiting for elapsed capture'}</div>
      </div>
      <div class="projection-status-card ${jplhCard.tone}">
        <div class="projection-status-label">${statusLabels.jplh}</div>
        <div class="projection-status-value">${jplhCard.value}</div>
        <div class="projection-status-sub">${jplhCard.sub}</div>
      </div>
      <div class="projection-status-card ${bypassCard.tone}">
        <div class="projection-status-label">${statusLabels.bypass}</div>
        <div class="projection-status-value">${bypassCard.value}</div>
        <div class="projection-status-sub">${bypassCard.sub}</div>
      </div>
      <div class="projection-status-card ${nextCard.tone}">
        <div class="projection-status-label">${statusLabels.next}</div>
        <div class="projection-status-value">${nextCard.value}</div>
        <div class="projection-status-sub">${nextCard.sub}</div>
      </div>
      <div class="projection-status-card ${freshCard.tone}">
        <div class="projection-status-label">${statusLabels.fresh}</div>
        <div class="projection-status-value">${freshCard.value}</div>
        <div class="projection-status-sub">${freshCard.sub}</div>
      </div>
      <div class="projection-status-card ${projectionState.worstStack < -avgRate * 0.5 ? 'bad' : projectionState.worstStack < -avgRate * 0.25 ? 'warn' : 'good'}">
        <div class="projection-status-label">${statusLabels.struggling}</div>
        <div class="projection-status-value">${struggling ? struggling.label : '-'}</div>
        <div class="projection-status-sub">${struggling ? `${signed(struggling.gap)} vs clock target` : 'No elapsed period yet'}</div>
      </div>
      <div class="projection-status-card ${progressTone}">
        <div class="projection-status-label">${statusLabels.progress}</div>
        <div class="projection-status-value">${progressValue}</div>
        <div class="projection-status-sub">${progressSub}${projectionState.startedRows || shiftComplete ? ` | clock ${fmt(clockPct, 1)}% elapsed` : ''}</div>
      </div>
    `;
  }
  if (needs) {
    needs.innerHTML = `
      <div class="projection-section-title">Period Actuals</div>
      <div class="projection-needs-grid">
        ${projectionState.periodResults.map((item) => {
          const left = Math.max(0, item.target - item.actual);
          const gap = item.gap == null ? null : item.gap;
          const toneClass = gap == null ? '' : colorClass(gap);
          return `
            <article class="projection-need-card">
              <div class="projection-need-head">
                <b>${item.label}</b>
                <span>${fmt(left)} left</span>
              </div>
              <div class="projection-need-line"><span>Clock target</span><b>${fmt(item.expected)}</b></div>
              <div class="projection-need-line"><span>Actual</span><b>${item.started ? fmt(item.actual) : '-'}</b></div>
              <div class="projection-need-line"><span>Variance</span><b class="${toneClass}">${gap == null ? '-' : signed(gap)}</b></div>
              <div class="projection-need-line"><span>Period goal</span><b>${fmt(item.target)}</b></div>
            </article>
          `;
        }).join('')}
      </div>
      ${closedPeriods.length ? `
        <div class="projection-section-title">Closed Periods</div>
        <div class="projection-callout-grid">
          ${closedPeriods.map((item) => `
            <article class="projection-callout ${item.gap >= 0 ? 'good' : item.gap < -avgRate * 0.5 ? 'bad' : 'warn'}">
              <b>${item.label} Closed</b>
              <span>${fmt(item.actual)} / ${fmt(item.target)} (${signed(item.gap)})</span>
            </article>
          `).join('')}
        </div>
      ` : ''}
    `;
  }
  if (script) {
    const bypassText = downtimeNotes(rows);
    const bypassSuffix = bypassText.length ? ` Bypass applied: ${bypassText.join(' | ')}.` : '';
    const message = projectionState.startedRows
      ? `${isMetShift ? 'MET ' : ''}${paceLabel}: shift is ${signed(currentGap)} vs clock target. ${currentPeriodRow ? `${currentWindow.period} needs ${fmt(currentPeriodRecoveryRate, 0)}/hr for the remaining ${fmt(currentPeriodRemainingHours, 1)} active hrs. ` : nextPeriodRow ? `Next ${nextWindow.period} planned at ${fmt(nextPeriodRate, 0)}/hr. ` : ''}${isMetShift ? 'MET finish' : 'Shift'} needs ${fmt(catchUpRate, 0)}/hr over ${fmt(remainingHours, 1)} active hrs to finish goal.${struggling ? ` Priority period: ${struggling.label} (${signed(struggling.gap)}).` : ''}${bypassSuffix}`
      : `${isMetShift ? 'MET plan' : 'Plan'} is loaded at ${fmt(avgRate, 0)}/active hr. Add FL Utilization Actuals as the night moves and this will turn into the live update.${bypassSuffix}`;
    script.innerHTML = `
      <div class="projection-script-head">
        <div class="projection-script-label">Auto update note</div>
        <button id="copyProjectionUpdateBtn" class="tinybtn" type="button">Copy</button>
      </div>
      <div id="projectionUpdateText" class="projection-script-text">${message}</div>
    `;
  }
}

function renderSnapshot(full, board) {
  setText('snapObGoal', fmt(board.eos.obGoal));
  setText('snapCapture', fmt(board.eos.capture));
  setText('snapCaptureGap', `gap ${(board.eos.captureGap >= 0 ? '+' : '') + fmt(board.eos.captureGap)}`, colorClass(board.eos.captureGap));
  setText('snapJplh', fmt(full.actualJplh, 2), colorClass(full.gap));
  setText('snapJplhGap', `vs required ${fmt(full.requiredJplh, 2)} | ${(full.gap >= 0 ? '+' : '') + fmt(full.gap, 2)}`, colorClass(full.gap));
  const burned = board.eos.obGoal > 0 ? (board.eos.obGoal - board.eos.remain) / board.eos.obGoal * 100 : 0;
  setText('snapRemain', fmt(board.eos.remain), board.eos.remain <= 0 ? 'good' : 'warn');
  setText('snapBurned', `burned ${pct(burned, 1)}`, burned >= 100 ? 'good' : 'warn');
  const fluidPct = board.eos.flGoal > 0 ? board.eos.fl / board.eos.flGoal * 100 : 0;
  setText('snapFluidGoal', fmt(board.eos.flGoal));
  setText('snapFluidCaptured', fmt(board.eos.fl));
  setText('snapFluidCapturedSub', `${pct(fluidPct, 1)} of FL goal`, fluidPct >= 100 ? 'good' : 'warn');
  setText('snapFluidLeft', fmt(board.eos.flRemain), board.eos.flRemain <= 0 ? 'good' : 'warn');
  const mpPct = board.eos.mpGoal > 0 ? board.eos.mp / board.eos.mpGoal * 100 : 0;
  setText('snapMpGoal', fmt(board.eos.mpGoal));
  setText('snapMpCaptured', fmt(board.eos.mp));
  setText('snapMpCapturedSub', `${pct(mpPct, 1)} of MP / DP goal`, mpPct >= 100 ? 'good' : 'warn');
  setText('snapMpLeft', fmt(board.eos.mpRemain), board.eos.mpRemain <= 0 ? 'good' : 'warn');
  const rwcPct = board.eos.rwcGoal > 0 ? board.eos.rwc / board.eos.rwcGoal * 100 : 0;
  setText('snapRwcGoal', fmt(board.eos.rwcGoal));
  setText('snapRwcCaptured', fmt(board.eos.rwc));
  setText('snapRwcCapturedSub', `${pct(rwcPct, 1)} of RWC goal`, rwcPct >= 100 ? 'good' : 'warn');
  setText('snapRwcLeft', fmt(board.eos.rwcRemain), board.eos.rwcRemain <= 0 ? 'good' : 'warn');
}

function buildSummaries(board, full) {
  const spread = periodSpreadAnalysis();
  const bypassLines = downtimeNotes(plan());
  const spreadLines = spread.periods
    .filter((period) => period.capture > 0)
    .map((period) => {
      const chunks = period.segmentRows
        .map((segment) => `${segment.label} ${segment.actual == null ? '-' : fmt(segment.actual)}/${fmt(segment.should)}${segment.gap == null ? '' : ` ${signed(segment.gap)}`}`)
        .join(' | ');
      return `${period.label}: ${chunks}`;
    });
  const struggleLine = spread.worstSegment
    ? `Biggest miss: ${spread.worstSegment.period} ${spread.worstSegment.label} (${fmt(spread.worstSegment.actual)} hit / ${fmt(spread.worstSegment.should)} target, ${signed(spread.worstSegment.gap)}).`
    : spread.worstPeriod
      ? `Biggest miss: ${spread.worstPeriod.label} (${signed(spread.worstPeriod.gap)} vs period goal).`
      : 'Biggest miss: pending FL Utilization Actual.';
  const periodSummary = `PERIOD SUMMARY
${board.lines.join('\n')}

PERIOD SPREAD
${spreadLines.length ? spreadLines.join('\n') : 'No FL Utilization Actual entered yet.'}${bypassLines.length ? `\n\nBYPASS / NO-RUN TIME\n${bypassLines.join('\n')}` : ''}`;
  const eosNotes = ($('eos_notes')?.value || '').trim();

  const eosWash = `EOS WASH
${bypassLines.length ? `Bypass: ${bypassLines.join(' | ')}\n` : ''}Capture: ${fmt(board.eos.capture)} vs OB Goal ${fmt(board.eos.obGoal)} (${(board.eos.captureGap >= 0 ? '+' : '') + fmt(board.eos.captureGap)})
Full Shift JPLH: ${fmt(full.actualJplh, 2)} vs Required ${fmt(full.requiredJplh, 2)} (${(full.gap >= 0 ? '+' : '') + fmt(full.gap, 2)})
Belt: ${fmt(board.eos.belt)} vs Fluid Goal ${fmt(board.eos.flGoal)} (${(board.eos.beltGap >= 0 ? '+' : '') + fmt(board.eos.beltGap)})
Remaining: ${fmt(board.eos.remain)}
${struggleLine}

Notes:
${eosNotes || 'No EOS notes entered.'}`;

  if (!periodSummaryEdited) {
    $('periodSummary').value = periodSummary;
  }
  if (!eosSummaryEdited) {
    $('eosSummary').value = eosWash;
  }
  if (!generatedCopyEdited) {
    $('generatedCopyBlock').value = buildGeneratedCopyBlock(board, full);
  }
}

function buildGeneratedCopyBlock(board, full) {
  const rows = plan();
  const periodData = periodMetrics(rows);
  const spread = periodSpreadAnalysis(rows);
  const bypassLines = downtimeNotes(rows);
  const totalHours = activePeriods().reduce((s, p) => s + effectivePeriodHours(p), 0);
  const fluidCapacity = val('fluidRate') * val('fluidHC') * totalHours;
  const fluidCapacityGap = fluidCapacity - val('goalFluid');
  const goalOb = val('goalFluid') + val('goalMp') + val('goalRwc');
  const divertGap = goalOb - val('shipSortGoal');
  const pctOf = (actual, target) => target > 0 ? actual / target * 100 : 0;
  const eosNotes = ($('eos_notes')?.value || '').trim();
  const blockLines = [
    `RFD2 OB SUMMARY - ${$('shiftDate').value || ''}`,
    String($('useMET').value) === 'true' ? 'MET enabled' : 'Standard shift',
    ...(bypassLines.length ? [`Bypass: ${bypassLines.join(' | ')}`] : []),
    '',
    `OB: ${fmt(board.eos.capture)} / ${fmt(board.eos.obGoal)} (${signed(board.eos.captureGap)}, ${fmt(pctOf(board.eos.capture, board.eos.obGoal), 1)}%)`,
    `Remaining: ${fmt(board.eos.remain)} OB | ${fmt(board.eos.flRemain)} FL`,
    `JPLH: ${fmt(full.actualJplh, 2)} / ${fmt(full.requiredJplh, 2)} (${signed(full.gap, 2)})`,
    `Belt: ${fmt(board.eos.belt)} / ${fmt(board.eos.flGoal)} FL (${signed(board.eos.beltGap)})`,
    fluidRosterHcSummary(),
    '',
    `Plan: FL ${fmt(val('goalFluid'))} | MP ${fmt(val('goalMp'))} | RWC ${fmt(val('goalRwc'))} | OB ${fmt(goalOb)} | Ship Sort ${fmt(val('shipSortGoal'))} (${signed(divertGap)})`,
    `FL capacity: ${fmt(fluidCapacity)} (${signed(fluidCapacityGap)})`,
    `Actual mix: FL ${fmt(board.eos.fl)} | MP ${fmt(board.eos.mp)} | RWC ${fmt(board.eos.rwc)}`,
    spread.worstSegment
      ? `Biggest miss: ${spread.worstSegment.period} ${spread.worstSegment.label} (${fmt(spread.worstSegment.actual)} / ${fmt(spread.worstSegment.should)}, ${signed(spread.worstSegment.gap)})`
      : 'Biggest miss: pending FL Utilization Actual',
    '',
    'By period:',
    ...periodData.map((p) => {
      const capturePct = p.total > 0 ? p.capture / p.total * 100 : 0;
      return `${p.label}: OB ${fmt(p.capture)} / ${fmt(p.total)} (${signed(p.captureGap)}, ${fmt(capturePct, 1)}%) | JPLH ${fmt(p.jplh, 2)} (${signed(p.jplhGap, 2)}) | Belt ${fmt(p.belt)} / ${fmt(p.fl)} (${signed(p.beltGap)})`;
    })
  ];

  if (eosNotes) {
    blockLines.push('', `Notes: ${eosNotes}`);
  }

  return blockLines.join('\n');
}

function parseDateOnly(dateStr) {
  const [y, m, d] = (dateStr || new Date().toISOString().slice(0, 10)).split('-').map(Number);
  return new Date(y, m - 1, d);
}

function formatDateOnly(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function addLocalDays(date, days) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function weekSunToWed(dateStr) {
  const date = parseDateOnly(dateStr);
  const start = addLocalDays(date, -date.getDay());
  const dates = [0, 1, 2, 3].map((offset) => formatDateOnly(addLocalDays(start, offset)));
  return { start: dates[0], end: dates[3], dates };
}

function loadShiftLog() {
  try {
    const log = JSON.parse(localStorage.getItem(SHIFT_LOG_KEY) || '[]');
    return Array.isArray(log) ? log : [];
  } catch {
    return [];
  }
}

function saveShiftLog(log) {
  localStorage.setItem(SHIFT_LOG_KEY, JSON.stringify(log));
}

function normalizeImportDate(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const iso = raw.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (iso) return `${iso[1]}-${iso[2].padStart(2, '0')}-${iso[3].padStart(2, '0')}`;
  const us = raw.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{2,4})/);
  if (!us) return raw;
  const year = us[3].length === 2 ? `20${us[3]}` : us[3];
  return `${year}-${us[1].padStart(2, '0')}-${us[2].padStart(2, '0')}`;
}

function pickImportField(row, names) {
  const wanted = names.map((name) => name.toLowerCase());
  const key = Object.keys(row || {}).find((item) => wanted.includes(item.toLowerCase().trim()));
  return key ? row[key] : undefined;
}

function normalizeShiftLogEntry(row) {
  const date = normalizeImportDate(pickImportField(row, ['date', 'shiftDate', 'shift_date', 'Shift Date']));
  if (!date) return null;
  const obGoal = num(pickImportField(row, ['obGoal', 'goal', 'shiftGoal', 'Shift Goal']));
  const obCaptured = num(pickImportField(row, ['obCaptured', 'capture', 'actual', 'totalCapture', 'Total Capture']));
  const flGoal = num(pickImportField(row, ['flGoal', 'fluidGoal', 'fluidLoadJobs', 'FL Goal']));
  const flCaptured = num(pickImportField(row, ['flCaptured', 'fl', 'fluid', 'fluidLoad', 'FL']));
  const rwcGoal = num(pickImportField(row, ['rwcGoal', 'RWC Goal']));
  const rwcCaptured = num(pickImportField(row, ['rwcCaptured', 'rwc', 'RWC']));
  const mpGoal = num(pickImportField(row, ['mpGoal', 'manualPalletizeGoal', 'MP Goal']));
  const mpCaptured = num(pickImportField(row, ['mpCaptured', 'mp', 'manualPalletize', 'MP']));
  const belt = num(pickImportField(row, ['belt', 'beltTotal', 'Belt'])) ||
    num(pickImportField(row, ['beltEast', 'east'])) + num(pickImportField(row, ['beltWest', 'west']));
  return {
    date,
    met: ['true', '1', 'yes', 'on'].includes(String(pickImportField(row, ['met', 'useMET']) || '').toLowerCase()),
    xbeltMinutes: num(pickImportField(row, ['xbeltMinutes', 'xBeltMinutes', 'xbelt'])),
    obGoal,
    obCaptured,
    obGap: pickImportField(row, ['obGap', 'gap']) !== undefined
      ? num(pickImportField(row, ['obGap', 'gap']))
      : obCaptured - obGoal,
    flGoal,
    flCaptured,
    flLeft: pickImportField(row, ['flLeft']) !== undefined ? num(pickImportField(row, ['flLeft'])) : Math.max(0, flGoal - flCaptured),
    mpGoal,
    mpCaptured,
    rwcGoal,
    rwcCaptured,
    rwcLeft: pickImportField(row, ['rwcLeft']) !== undefined ? num(pickImportField(row, ['rwcLeft'])) : Math.max(0, rwcGoal - rwcCaptured),
    jplh: num(pickImportField(row, ['jplh', 'actualJplh', 'Shift JPLH'])),
    reqJplh: num(pickImportField(row, ['reqJplh', 'requiredJplh', 'required_jplh', 'required'])),
    jplhGap: num(pickImportField(row, ['jplhGap'])),
    belt,
    beltGoal: num(pickImportField(row, ['beltGoal'])) || flGoal,
    beltGap: pickImportField(row, ['beltGap']) !== undefined ? num(pickImportField(row, ['beltGap'])) : belt - flGoal,
    savedAt: pickImportField(row, ['savedAt', 'saved_at']) || new Date().toISOString()
  };
}

function parseShiftLogCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    const next = text[i + 1];
    if (ch === '"' && quoted && next === '"') {
      cell += '"';
      i += 1;
    } else if (ch === '"') {
      quoted = !quoted;
    } else if (ch === ',' && !quoted) {
      row.push(cell);
      cell = '';
    } else if ((ch === '\n' || ch === '\r') && !quoted) {
      if (ch === '\r' && next === '\n') i += 1;
      row.push(cell);
      if (row.some((value) => value.trim())) rows.push(row);
      row = [];
      cell = '';
    } else {
      cell += ch;
    }
  }
  row.push(cell);
  if (row.some((value) => value.trim())) rows.push(row);
  if (rows.length < 2) return [];
  const headers = rows[0].map((header) => header.trim());
  return rows.slice(1).map((values) => Object.fromEntries(headers.map((header, index) => [header, values[index] || ''])));
}

function extractImportedShiftLogs(text) {
  const trimmed = text.trim();
  if (!trimmed) return [];
  const unpack = (value) => {
    if (Array.isArray(value)) return value;
    if (typeof value !== 'string') return [];
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  };
  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) return parsed;
    if (parsed.logs) return unpack(parsed.logs);
    if (parsed.shiftLogs) return unpack(parsed.shiftLogs);
    if (parsed[SHIFT_LOG_KEY]) return unpack(parsed[SHIFT_LOG_KEY]);
    if (parsed[LEGACY_SHIFT_LOG_KEY]) return unpack(parsed[LEGACY_SHIFT_LOG_KEY]);
    if (parsed.date || parsed.shiftDate) return [parsed];
  } catch {
    return parseShiftLogCsv(trimmed);
  }
  return [];
}

function importShiftLogsText(text) {
  const imported = extractImportedShiftLogs(text).map(normalizeShiftLogEntry).filter(Boolean);
  if (!imported.length) throw new Error('No shift logs found');
  const merged = new Map(loadShiftLog().map((entry) => [entry.date, entry]));
  imported.forEach((entry) => merged.set(entry.date, entry));
  const next = [...merged.values()].sort((a, b) => String(b.date).localeCompare(String(a.date))).slice(0, 80);
  saveShiftLog(next);
  renderAll();
  updateMiniStatus(`Imported ${imported.length} shift log${imported.length === 1 ? '' : 's'}.`);
}

function importShiftLogsFile(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      importShiftLogsText(String(reader.result || ''));
    } catch (err) {
      updateMiniStatus(`Log import failed: ${err.message}`);
    }
  };
  reader.onerror = () => updateMiniStatus('Log import failed: could not read file.');
  reader.readAsText(file);
}

function exportShiftLogs() {
  const log = loadShiftLog();
  const blob = new Blob([JSON.stringify({ shiftLogs: log }, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `ob-shift-results-${$('shiftDate')?.value || new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
  updateMiniStatus(`Exported ${log.length} shift log${log.length === 1 ? '' : 's'}.`);
}

function currentXbeltEvents() {
  const date = $('shiftDate')?.value || new Date().toISOString().slice(0, 10);
  return activePeriods()
    .filter((period) => downtimeReason(period.key) === 'xbelt' && downtimeMinutes(period.key) > 0)
    .map((period) => ({
      id: `${date}-${period.key}-${Date.now()}`,
      date,
      period: period.label,
      minutes: downtimeMinutes(period.key),
      amount: val(`${period.key}_downtime_amount`),
      unit: $(`${period.key}_downtime_unit`)?.value || 'min',
      note: `${period.label} X-belt down for ${formatDowntime(downtimeMinutes(period.key))}`,
      savedAt: new Date().toISOString()
    }));
}

function loadXbeltLog() {
  try {
    const log = JSON.parse(localStorage.getItem(XBELT_LOG_KEY) || '[]');
    return Array.isArray(log) ? log : [];
  } catch {
    return [];
  }
}

function saveXbeltLog(log) {
  localStorage.setItem(XBELT_LOG_KEY, JSON.stringify(log));
}

function saveCurrentXbeltEvents() {
  const events = currentXbeltEvents();
  if (!events.length) {
    updateMiniStatus('No X-belt downtime entered to save.');
    return;
  }
  const existing = loadXbeltLog();
  const next = [...events, ...existing].slice(0, 80);
  saveXbeltLog(next);
  renderXbeltLog();
  updateMiniStatus(`Saved ${events.length} X-belt downtime event${events.length === 1 ? '' : 's'}.`);
}

function xbeltLogText() {
  const log = loadXbeltLog();
  if (!log.length) return 'XBELT DOWNTIME LOG\nNo saved X-belt downtime events.';
  return [
    'XBELT DOWNTIME LOG',
    ...log.map((item) => `${item.date} ${item.period}: ${formatDowntime(item.minutes)} | saved ${ageText(item.savedAt)}`)
  ].join('\n');
}

function copyXbeltLog() {
  navigator.clipboard.writeText(xbeltLogText());
  updateMiniStatus('Copied X-belt downtime log.');
}

function clearXbeltLog() {
  if (!confirm('Clear saved X-belt downtime log?')) return;
  localStorage.removeItem(XBELT_LOG_KEY);
  renderXbeltLog();
  updateMiniStatus('X-belt downtime log cleared.');
}

function renderXbeltLog() {
  const el = $('xbeltLogList');
  if (!el) return;
  const log = loadXbeltLog();
  el.innerHTML = log.length ? log.map((item) => `
    <article class="xbelt-log-row">
      <div><b>${item.date}</b></div>
      <div>${item.period}</div>
      <div><b>${formatDowntime(item.minutes)}</b></div>
      <div>${item.note || 'X-belt down'} | saved ${ageText(item.savedAt)}</div>
    </article>
  `).join('') : '<div class="empty-log">No saved X-belt downtime events yet.</div>';
}

function makeShiftLogEntry(board, full) {
  const date = $('shiftDate').value || new Date().toISOString().slice(0, 10);
  const xbeltMinutes = currentXbeltEvents().reduce((sum, item) => sum + num(item.minutes), 0);
  return {
    date,
    met: $('useMET').value === 'true',
    xbeltMinutes,
    obGoal: board.eos.obGoal,
    obCaptured: board.eos.capture,
    obGap: board.eos.captureGap,
    flGoal: board.eos.flGoal,
    flCaptured: board.eos.fl,
    flLeft: board.eos.flRemain,
    mpGoal: board.eos.mpGoal,
    mpCaptured: board.eos.mp,
    rwcGoal: board.eos.rwcGoal,
    rwcCaptured: board.eos.rwc,
    rwcLeft: board.eos.rwcRemain,
    jplh: full.actualJplh,
    reqJplh: full.requiredJplh,
    jplhGap: full.gap,
    belt: board.eos.belt,
    beltGoal: board.eos.flGoal,
    beltGap: board.eos.beltGap,
    savedAt: new Date().toISOString()
  };
}

function sumLog(entries) {
  return entries.reduce((totals, item) => {
    ['obGoal', 'obCaptured', 'obGap', 'flGoal', 'flCaptured', 'flLeft', 'mpGoal', 'mpCaptured', 'rwcGoal', 'rwcCaptured', 'rwcLeft', 'belt', 'beltGoal', 'beltGap'].forEach((key) => {
      totals[key] = (totals[key] || 0) + num(item[key]);
    });
    totals.jplhWeightedJobs = (totals.jplhWeightedJobs || 0) + num(item.jplh) * Math.max(0, num(item.flCaptured));
    totals.reqWeightedJobs = (totals.reqWeightedJobs || 0) + num(item.reqJplh) * Math.max(0, num(item.flGoal));
    return totals;
  }, {});
}

function logMetric(label, value, sub = '') {
  return `
    <div class="log-metric">
      <div class="log-label">${label}</div>
      <div class="log-value">${value}</div>
      ${sub ? `<div class="log-sub">${sub}</div>` : ''}
    </div>
  `;
}

function renderShiftLog(board, full) {
  currentShiftLogEntry = makeShiftLogEntry(board, full);
  const log = loadShiftLog().sort((a, b) => String(b.date).localeCompare(String(a.date)));
  updateSaveCounter(log);
  const week = weekSunToWed(currentShiftLogEntry.date);
  const weekEntries = log.filter((item) => week.dates.includes(item.date));
  const totals = sumLog(weekEntries);
  const weeklyObPct = totals.obGoal > 0 ? totals.obCaptured / totals.obGoal * 100 : 0;
  const weeklyFlPct = totals.flGoal > 0 ? totals.flCaptured / totals.flGoal * 100 : 0;
  const weeklyRwcPct = totals.rwcGoal > 0 ? totals.rwcCaptured / totals.rwcGoal * 100 : 0;
  const weeklyJplh = totals.jplhWeightedJobs && totals.flCaptured ? totals.jplhWeightedJobs / totals.flCaptured : 0;
  const weeklyReqJplh = totals.reqWeightedJobs && totals.flGoal ? totals.reqWeightedJobs / totals.flGoal : 0;

  if ($('shiftLogCurrent')) {
    const savedForDate = log.find((item) => item.date === currentShiftLogEntry.date);
    $('shiftLogCurrent').innerHTML = `
      <div class="log-section-title">Current Shift Ready To Save</div>
      <div class="log-lock ${savedForDate ? 'locked' : ''}">
        <b>${savedForDate ? 'Saved shift is locked' : 'Not saved yet'}</b>
        <span>${savedForDate ? `Saved ${ageText(savedForDate.savedAt)}. Use Update Saved Shift if this date needs changes.` : 'Save once the shift is final. Reset will keep this log.'}</span>
      </div>
      <div class="log-card-grid">
        ${logMetric('Date', currentShiftLogEntry.date, currentShiftLogEntry.met ? 'MET enabled' : 'standard shift')}
        ${logMetric('X-belt Down', formatDowntime(currentShiftLogEntry.xbeltMinutes || 0), 'current shift bypass')}
        ${logMetric('OB', `${fmt(currentShiftLogEntry.obCaptured)} / ${fmt(currentShiftLogEntry.obGoal)}`, `${signed(currentShiftLogEntry.obGap)} gap`)}
        ${logMetric('FL', `${fmt(currentShiftLogEntry.flCaptured)} / ${fmt(currentShiftLogEntry.flGoal)}`, `${fmt(currentShiftLogEntry.flLeft)} left`)}
        ${logMetric('MP', `${fmt(currentShiftLogEntry.mpCaptured)} / ${fmt(currentShiftLogEntry.mpGoal)}`)}
        ${logMetric('RWC', `${fmt(currentShiftLogEntry.rwcCaptured)} / ${fmt(currentShiftLogEntry.rwcGoal)}`, `${fmt(currentShiftLogEntry.rwcLeft)} left`)}
        ${logMetric('JPLH', `${fmt(currentShiftLogEntry.jplh, 2)} / ${fmt(currentShiftLogEntry.reqJplh, 2)}`, `${signed(currentShiftLogEntry.jplhGap, 2)} gap`)}
      </div>
    `;
    if ($('saveShiftLogBtn')) $('saveShiftLogBtn').disabled = !!savedForDate;
    if ($('updateShiftLogBtn')) $('updateShiftLogBtn').hidden = !savedForDate;
  }

  if ($('shiftLogWeek')) {
    $('shiftLogWeek').innerHTML = `
      <div class="log-section-title">Week Rollup: ${week.start} to ${week.end}</div>
      <div class="log-card-grid">
        ${logMetric('Saved Shifts', fmt(weekEntries.length), 'Sun-Wed only')}
        ${logMetric('X-belt Down', formatDowntime(weekEntries.reduce((sum, item) => sum + num(item.xbeltMinutes), 0)), 'saved shift total')}
        ${logMetric('OB', `${fmt(totals.obCaptured)} / ${fmt(totals.obGoal)}`, `${signed(totals.obCaptured - totals.obGoal)} gap | ${pct(weeklyObPct, 1)}`)}
        ${logMetric('FL', `${fmt(totals.flCaptured)} / ${fmt(totals.flGoal)}`, `${fmt(totals.flGoal - totals.flCaptured)} left | ${pct(weeklyFlPct, 1)}`)}
        ${logMetric('MP', `${fmt(totals.mpCaptured)} / ${fmt(totals.mpGoal)}`)}
        ${logMetric('RWC', `${fmt(totals.rwcCaptured)} / ${fmt(totals.rwcGoal)}`, `${fmt(totals.rwcGoal - totals.rwcCaptured)} left | ${pct(weeklyRwcPct, 1)}`)}
        ${logMetric('JPLH', `${fmt(weeklyJplh, 2)} / ${fmt(weeklyReqJplh, 2)}`, `${signed(weeklyJplh - weeklyReqJplh, 2)} gap`)}
      </div>
    `;
  }

  if ($('shiftLogList')) {
    $('shiftLogList').innerHTML = `
      <div class="log-section-title">Saved Shifts</div>
      ${log.length ? log.map((item) => `
        <article class="shift-log-row">
          <div>
            <div class="shift-log-date">${item.date}${item.met ? ' | MET' : ''}</div>
            <div class="shift-log-sub">OB ${fmt(item.obCaptured)} / ${fmt(item.obGoal)} (${signed(num(item.obGap))})${item.xbeltMinutes ? ` | X-belt ${formatDowntime(item.xbeltMinutes)}` : ''}</div>
          </div>
          <div>FL <b>${fmt(item.flCaptured)}</b> / ${fmt(item.flGoal)}</div>
          <div>MP <b>${fmt(item.mpCaptured)}</b> / ${fmt(item.mpGoal)}</div>
          <div>RWC <b>${fmt(item.rwcCaptured)}</b> / ${fmt(item.rwcGoal)}</div>
          <div>JPLH <b>${fmt(item.jplh, 2)}</b></div>
        </article>
      `).join('') : '<div class="empty-log">No saved shifts yet.</div>'}
    `;
  }
  renderXbeltLog();
}

function saveCurrentShiftResults(forceUpdate = false) {
  if (!currentShiftLogEntry) return;
  const log = loadShiftLog();
  const existing = log.find((item) => item.date === currentShiftLogEntry.date);
  if (existing && !forceUpdate) {
    updateMiniStatus(`Shift results for ${currentShiftLogEntry.date} are locked. Use Update Saved Shift to replace them.`);
    return;
  }
  const next = [currentShiftLogEntry, ...log.filter((item) => item.date !== currentShiftLogEntry.date)]
    .sort((a, b) => String(b.date).localeCompare(String(a.date)));
  saveShiftLog(next);
  renderAll();
  updateMiniStatus(`${existing ? 'Updated' : 'Saved'} shift results for ${currentShiftLogEntry.date}.`);
}

function updateCurrentShiftResults() {
  saveCurrentShiftResults(true);
}

function saveBoardAndLog() {
  saveState(false);
  if (!currentShiftLogEntry) renderAll();
  saveCurrentShiftResults(true);
}

function weekLogText() {
  const log = loadShiftLog();
  const date = currentShiftLogEntry?.date || $('shiftDate').value || new Date().toISOString().slice(0, 10);
  const week = weekSunToWed(date);
  const entries = log.filter((item) => week.dates.includes(item.date)).sort((a, b) => String(a.date).localeCompare(String(b.date)));
  const totals = sumLog(entries);
  return [
    `SHIFT RESULTS LOG | ${week.start} to ${week.end}`,
    `Saved shifts: ${entries.length}`,
    `X-belt downtime: ${formatDowntime(entries.reduce((sum, item) => sum + num(item.xbeltMinutes), 0))}`,
    `Week OB: ${fmt(totals.obCaptured)} / ${fmt(totals.obGoal)} (${signed((totals.obCaptured || 0) - (totals.obGoal || 0))})`,
    `Week FL: ${fmt(totals.flCaptured)} / ${fmt(totals.flGoal)}`,
    `Week MP: ${fmt(totals.mpCaptured)} / ${fmt(totals.mpGoal)}`,
    `Week RWC: ${fmt(totals.rwcCaptured)} / ${fmt(totals.rwcGoal)}`,
    '',
    ...entries.map((item) => `${item.date}: OB ${fmt(item.obCaptured)} / ${fmt(item.obGoal)} (${signed(num(item.obGap))}) | FL ${fmt(item.flCaptured)} / ${fmt(item.flGoal)} | MP ${fmt(item.mpCaptured)} / ${fmt(item.mpGoal)} | RWC ${fmt(item.rwcCaptured)} / ${fmt(item.rwcGoal)} | JPLH ${fmt(item.jplh, 2)} | X-belt ${formatDowntime(item.xbeltMinutes || 0)}`)
  ].join('\n');
}

function copyWeekLog() {
  navigator.clipboard.writeText(weekLogText());
  updateMiniStatus('Copied week shift log.');
}

function clearShiftLog() {
  if (!confirm('Clear all saved shift results?')) return;
  localStorage.removeItem(SHIFT_LOG_KEY);
  renderAll();
  updateMiniStatus('Shift results log cleared.');
}

function ageText(iso) {
  if (!iso) return 'not saved yet';
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return 'just now';
  const minutes = Math.floor(ms / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  return `${Math.floor(hours / 24)} day ago`;
}

function insightCard(title, value, sub = '', tone = '') {
  return `
    <article class="insight-card ${tone}">
      <div class="insight-title">${title}</div>
      <div class="insight-value">${value}</div>
      ${sub ? `<div class="insight-sub">${sub}</div>` : ''}
    </article>
  `;
}

function renderOperationsInsights(board, full) {
  const log = loadShiftLog();
  const currentDate = $('shiftDate').value || new Date().toISOString().slice(0, 10);
  const savedForDate = log.find((item) => item.date === currentDate);
  const lastSaved = [...log].sort((a, b) => String(b.savedAt || '').localeCompare(String(a.savedAt || '')))[0];
  const week = weekSunToWed(currentDate);
  const weekEntries = log.filter((item) => week.dates.includes(item.date));
  const totals = sumLog(weekEntries);
  const weekGap = num(totals.obCaptured) - num(totals.obGoal);
  const bestDay = weekEntries.length ? [...weekEntries].sort((a, b) => num(b.obGap) - num(a.obGap))[0] : null;
  const worstDay = weekEntries.length ? [...weekEntries].sort((a, b) => num(a.obGap) - num(b.obGap))[0] : null;
  const missingDays = week.dates.filter((date) => !weekEntries.some((item) => item.date === date));
  const exceptions = [];

  if (board.eos.obGoal > 0 && board.eos.captureGap < 0) {
    exceptions.push({ tone: 'bad', title: 'OB behind', detail: `${fmt(Math.abs(board.eos.captureGap))} under shift goal` });
  }
  if (board.eos.flGoal > 0 && board.eos.flRemain > 0) {
    exceptions.push({ tone: 'warn', title: 'FL left', detail: `${fmt(board.eos.flRemain)} fluid remaining` });
  }
  if (board.eos.rwcGoal > 0 && board.eos.rwcRemain > 0) {
    exceptions.push({ tone: 'warn', title: 'RWC left', detail: `${fmt(board.eos.rwcRemain)} RWC remaining` });
  }
  if (full.requiredJplh > 0 && full.gap < 0) {
    exceptions.push({ tone: 'bad', title: 'JPLH low', detail: `${fmt(Math.abs(full.gap), 2)} below required` });
  }
  if (board.eos.flGoal > 0 && board.eos.beltGap < 0) {
    exceptions.push({ tone: 'warn', title: 'Belt below FL', detail: `${fmt(Math.abs(board.eos.beltGap))} under fluid goal` });
  }

  if ($('insightAlerts')) {
    $('insightAlerts').innerHTML = exceptions.length
      ? exceptions.map((item) => `<div class="insight-alert ${item.tone}"><b>${item.title}</b><span>${item.detail}</span></div>`).join('')
      : '<div class="insight-alert good"><b>No active exceptions</b><span>Current shift is at or above visible targets.</span></div>';
  }

  const focus = exceptions[0]
    ? `${exceptions[0].title}: ${exceptions[0].detail}`
    : weekEntries.length && weekGap < 0
      ? `Week is ${fmt(Math.abs(weekGap))} OB under through saved shifts`
      : 'Protect current pace and keep saved log updated';

  if ($('insightCards')) {
    $('insightCards').innerHTML = [
      insightCard('Current Shift', currentDate, savedForDate ? `saved ${ageText(savedForDate.savedAt)}` : 'not saved to log yet', savedForDate ? 'good' : 'warn'),
      insightCard('Last Saved Log', lastSaved?.date || 'None', lastSaved ? ageText(lastSaved.savedAt) : 'use Save Shift Results', lastSaved ? '' : 'warn'),
      insightCard('Week Saved', `${fmt(weekEntries.length)} / 4`, `${week.start} to ${week.end}`, weekEntries.length >= 4 ? 'good' : 'warn'),
      insightCard('Week OB Gap', signed(weekGap), `${fmt(num(totals.obCaptured))} / ${fmt(num(totals.obGoal))}`, weekGap >= 0 ? 'good' : 'bad'),
      insightCard('Best Day', bestDay ? bestDay.date : 'None', bestDay ? `OB gap ${signed(bestDay.obGap)}` : 'save shifts to build trend'),
      insightCard('Biggest Miss', worstDay ? worstDay.date : 'None', worstDay ? `OB gap ${signed(worstDay.obGap)}` : 'no saved misses yet', worstDay && num(worstDay.obGap) < 0 ? 'bad' : ''),
      insightCard('Missing Week Days', missingDays.length ? missingDays.join(', ') : 'None', 'Sun-Wed saved-log coverage', missingDays.length ? 'warn' : 'good'),
      insightCard('Suggested Focus', focus, 'auto-picked from current exceptions and week trend', exceptions.length || weekGap < 0 ? 'warn' : 'good')
    ].join('');
  }
}

function importBridge() {
  try {
    const data = JSON.parse($('bridgeJson').value || '{}');
    if (!hasUsableBridgeData(data)) {
      updateMiniStatus('Bridge JSON has no collected values yet.');
      return;
    }
    applyBridgeData(data);
    $('miniStatus').textContent = 'Bridge imported.';
    renderAll();
  } catch (err) {
    alert(`Bridge JSON import failed: ${err.message}`);
  }
}

function hasUsableBridgeData(data) {
  if (!data || typeof data !== 'object') return false;
  if (data.neo && Object.values(data.neo).some((value) => num(value) !== 0)) return true;
  if (data.fclmFull && Object.values(data.fclmFull).some((value) => num(value) !== 0)) return true;
  if (data.fclmPeriods && Object.values(data.fclmPeriods).some((row) => row && Object.values(row).some((value) => num(value) !== 0))) return true;
  if (data.monitorPeriods && Object.values(data.monitorPeriods).some((row) => {
    const flUtil = row?.flUtil || {};
    const belt = row?.belt || {};
    return [...Object.values(flUtil), ...Object.values(belt)].some((value) => num(value) !== 0);
  })) return true;
  if (data.monitorFull && Object.values(data.monitorFull).some((row) => row && Object.values(row).some((value) => num(value) !== 0))) return true;
  if (data.roster?.fluid?.updatedAt || data.roster?.fluid?.headcount != null) return true;
  if (data.source === 'dashboard-reset' || data.source === 'tampermonkey-reset') return false;
  return false;
}

function applyBridgeData(data) {
  latestBridgePayload = data || latestBridgePayload;

  if (data.neo) {
    setVal('goalFluid', data.neo.fluidLoadJobs);
    setVal('goalMp', data.neo.manualPalletizeJobs);
    setVal('goalRwc', data.neo.rwcJobs);
    setVal('shipSortGoal', data.neo.shipSortDiverts);
    setVal('fluidRate', data.neo.fluidLoadRate, 2);
    setVal('fluidHC', data.neo.fluidLoadHC);
  }

  if (data.fclmPeriods) {
    Object.entries(data.fclmPeriods).forEach(([k, row]) => {
      setVal(`${k}_totes`, row.totesJobs);
      setVal(`${k}_cases`, row.casesJobs);
      setVal(`${k}_jobs`, row.totalJobs);
      setVal(`${k}_wb`, row.wallBuilderRate, 2);
    });
  }

  if (data.fclmFull) {
    setVal('fullTotes', data.fclmFull.totesJobs);
    setVal('fullCases', data.fclmFull.casesJobs);
    setVal('fullJobs', data.fclmFull.totalJobs);
    setVal('fullWB', data.fclmFull.wallBuilderRate, 2);
  }

  if (data.monitorPeriods) {
    Object.entries(data.monitorPeriods).forEach(([k, row]) => {
      if (row.flUtil) {
        setVal(`${k}_flu_fl`, row.flUtil.fl);
        setVal(`${k}_flu_mp`, row.flUtil.mp);
        setVal(`${k}_flu_rwc`, row.flUtil.rwc);
      }

      if (row.belt) {
        setVal(`${k}_belt_east`, row.belt.east);
        setVal(`${k}_belt_west`, row.belt.west);
      }
    });
  }

  if (data.roster?.fluid) {
    const rosterEl = $('rosterFluidHC');
    if (rosterEl) {
      rosterEl.value = fmt(data.roster.fluid.headcount);
      manualLocks.delete('rosterFluidHC');
      saveManualLocks();
    }
  }

}

function importBridgePayload(data, status = 'Bridge imported.') {
  if (!hasUsableBridgeData(data)) {
    updateMiniStatus('Ignored empty bridge payload.');
    return false;
  }
  $('bridgeJson').value = JSON.stringify(data, null, 2);
  applyBridgeData(data);
  renderAll();
  updateMiniStatus(bridgePayloadStatus(data, status));
  return true;
}

function readStoredBridgePayload() {
  const keys = ['OB_PERIOD_REPORT_CARD_V2_HYBRID_BRIDGE', 'OB_PERIOD_REPORT_CARD_BRIDGE'];
  for (const key of keys) {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) continue;
      const parsed = JSON.parse(raw);
      if (hasUsableBridgeData(parsed)) return parsed;
    } catch {}
  }
  return null;
}

function importStoredBridgePayload(status = 'Bridge imported from storage.') {
  const payload = readStoredBridgePayload();
  if (!payload) {
    updateMiniStatus('No stored bridge data found yet.');
    return false;
  }

  importBridgePayload(payload, status);
  return true;
}

function startBridgeRefreshPoll(status = 'Bridge data refreshed.') {
  if (bridgeRefreshPollTimer) clearInterval(bridgeRefreshPollTimer);
  const startedAt = Date.now();
  let lastImportedAt = num(latestBridgePayload?.updatedAt);

  bridgeRefreshPollTimer = setInterval(() => {
    const payload = readStoredBridgePayload();
    const updatedAt = num(payload?.updatedAt);
    if (payload && updatedAt > lastImportedAt) {
      lastImportedAt = updatedAt || Date.now();
      importBridgePayload(payload, status);
    }
    if (Date.now() - startedAt > 45000) {
      clearInterval(bridgeRefreshPollTimer);
      bridgeRefreshPollTimer = null;
    }
  }, 1000);
}

async function pollServerBridge() {
  try {
    const res = await fetch(SERVER_BRIDGE_URL);
    if (!res.ok || res.status === 204) return;
    const json = await res.json();
    if (!json?.payload) return;
    const ts = json.receivedAt || 0;
    if (ts <= lastServerBridgeTs) return;
    lastServerBridgeTs = ts;
    importBridgePayload(json.payload, 'Bridge auto-imported.');
  } catch {}
}

function startServerBridgePoll() {
  if (serverBridgePollTimer) clearInterval(serverBridgePollTimer);
  serverBridgePollTimer = setInterval(pollServerBridge, 3000);
  pollServerBridge();
}

function exportState() {
  const state = {};
  document.querySelectorAll('input, select, textarea').forEach((el) => {
    if (!el.id) return;
    state[el.id] = el.value;
  });
  $('bridgeJson').value = JSON.stringify(state, null, 2);
}

function updateMiniStatus(msg) {
  $('miniStatus').textContent = msg;
}

function resetHybridBridgeState(shiftDate, includeMET) {
  const payload = {
    source: 'dashboard-reset',
    resetAt: new Date().toISOString(),
    updatedAt: Date.now(),
    shift: {
      shiftDate,
      includeMET,
      refreshMinutes: 15
    },
    neo: null,
    fclmFull: null,
    fclmPeriods: {},
    monitorFull: {},
    monitorPeriods: {}
  };
  latestBridgePayload = payload;

  try {
    localStorage.setItem('OB_PERIOD_REPORT_CARD_V2_HYBRID_BRIDGE', JSON.stringify(payload));
    localStorage.setItem('OB_PERIOD_REPORT_CARD_BRIDGE', JSON.stringify(payload));
  } catch {}

  window.postMessage({ type: 'PRC_V2_HYBRID_RESET', payload }, '*');
}

function clearWorkingShift(shiftDate, includeMET, statusMessage = '') {
  const keepTheme = $('themeSelect').value;
  const keepFocus = $('focusMode').value;
  const keepShiftDate = shiftDate || $('shiftDate').value || defaultShiftDateString();
  const keepMET = String(!!includeMET);
  const keepAutoFclm = $('autoFclmRefresh')?.value || '5';
  localStorage.removeItem(STORAGE_KEY);
  localStorage.removeItem(COPY_BLOCK_EDITED_KEY);
  localStorage.removeItem(PERIOD_SUMMARY_EDITED_KEY);
  localStorage.removeItem(EOS_SUMMARY_EDITED_KEY);
  localStorage.removeItem(MANUAL_LOCKS_KEY);
  localStorage.removeItem('OB_PERIOD_REPORT_CARD_V2_HYBRID_BRIDGE');
  localStorage.removeItem('OB_PERIOD_REPORT_CARD_BRIDGE');
  if (bridgeRefreshPollTimer) {
    clearInterval(bridgeRefreshPollTimer);
    bridgeRefreshPollTimer = null;
  }
  manualLocks.clear();
  generatedCopyEdited = false;
  periodSummaryEdited = false;
  eosSummaryEdited = false;

  document.querySelectorAll('input, textarea, select').forEach((el) => {
    if (!el.id) return;

    if (el.id === 'shiftDate') {
      el.value = keepShiftDate;
      return;
    }
    if (el.id === 'themeSelect') {
      el.value = keepTheme;
      return;
    }
    if (el.id === 'focusMode') {
      el.value = keepFocus;
      return;
    }
    if (el.id === 'useMET') {
      el.value = keepMET;
      return;
    }
    if (el.id === 'autoFclmRefresh') {
      el.value = keepAutoFclm;
      return;
    }
    if (el.tagName === 'TEXTAREA') {
      el.value = '';
      return;
    }
    if (el.tagName === 'SELECT') {
      el.selectedIndex = 0;
      return;
    }

    el.value = '0';
  });

  applyTheme(keepTheme);
  applyFocus(keepFocus);
  resetHybridBridgeState(keepShiftDate, includeMET);
  buildPeriodRows();
  renderAll();
  updateMiniStatus(statusMessage || `Reset working shift for ${keepShiftDate}${keepMET === 'true' ? ' with MET on.' : '.'}`);
}

function resetShift() {
  if (!confirm('Reset all working values for the next shift date? Saved shift results log will stay.')) return;
  const keepShiftDate = resetShiftDateTarget($('shiftDate').value);
  const includeMET = $('useMET').value === 'true';
  clearWorkingShift(keepShiftDate, includeMET, `Reset working shift for next day: ${keepShiftDate}${includeMET ? ' with MET on.' : '.'}`);
}

function buildFclmUrl(period = 'full') {
  const shiftDate = $('shiftDate').value || new Date().toISOString().slice(0, 10);
  const [y, m, d] = shiftDate.split('-').map(Number);
  const start = { y, m, d };
  const nextDate = new Date(Date.UTC(y, m - 1, d + 1, 12, 0, 0));
  const next = { y: nextDate.getUTCFullYear(), m: nextDate.getUTCMonth() + 1, d: nextDate.getUTCDate() };
  const pad = (n) => String(n).padStart(2, '0');
  const fmtDate = (obj) => `${obj.y}/${pad(obj.m)}/${pad(obj.d)}`;

  const win = {
    full: { sd: start, ed: next, sh: 19, sm: 0, eh: $('useMET').value === 'true' ? 6 : 5, em: 30 },
    p1: { sd: start, ed: start, sh: 19, sm: 0, eh: 23, em: 0 },
    p2: { sd: start, ed: next, sh: 23, sm: 30, eh: 2, em: 30 },
    p3: { sd: next, ed: next, sh: 3, sm: 0, eh: 5, em: 30 },
    met: { sd: next, ed: next, sh: 5, sm: 30, eh: 6, em: 30 }
  }[period] || null;

  if (!win) return '';

  const u = new URL('https://fclm-portal.amazon.com/reports/functionRollup');
  u.searchParams.set('reportFormat', 'HTML');
  u.searchParams.set('warehouseId', 'RFD2');
  u.searchParams.set('processId', '1003021');
  u.searchParams.set('maxIntradayDays', '1');
  u.searchParams.set('spanType', 'Intraday');
  u.searchParams.set('startDateIntraday', fmtDate(win.sd));
  u.searchParams.set('startHourIntraday', String(win.sh));
  u.searchParams.set('startMinuteIntraday', String(win.sm));
  u.searchParams.set('endDateIntraday', fmtDate(win.ed));
  u.searchParams.set('endHourIntraday', String(win.eh));
  u.searchParams.set('endMinuteIntraday', String(win.em));
  return monitorUrlString(u);
}

function openFclmPeriod(period) {
  const url = buildFclmUrl(period);
  if (url) window.open(url, '_blank', 'noopener,noreferrer');
}

function openNeoPlanning() {
  window.open('https://neo.meta.amazon.dev/planning', '_blank', 'noopener,noreferrer');
}

function openFluidRoster() {
  window.open(FLUID_ROSTER_URL, '_blank', 'noopener,noreferrer');
}

function toggleGeneratedCopyBlock() {
  $('generatedBlockWrap')?.classList.toggle('hidden');
  const collapsed = $('generatedBlockWrap')?.classList.contains('hidden');
  $('toggleGeneratedBlockBtn').textContent = collapsed ? 'Expand' : 'Collapse';
  localStorage.setItem(COPY_BLOCK_KEY, String(!!collapsed));
}

function toggleNotesWash() {
  $('notesWashWrap')?.classList.toggle('hidden');
  const collapsed = $('notesWashWrap')?.classList.contains('hidden');
  if ($('toggleNotesWashBtn')) $('toggleNotesWashBtn').textContent = collapsed ? 'Expand' : 'Collapse';
  localStorage.setItem(NOTES_WASH_KEY, String(!!collapsed));
}

function refreshGeneratedCopyBlock() {
  generatedCopyEdited = false;
  localStorage.removeItem(COPY_BLOCK_EDITED_KEY);
  renderAll();
  updateMiniStatus('Copy summary refreshed.');
}

function refreshGeneratedOutput() {
  periodSummaryEdited = false;
  eosSummaryEdited = false;
  localStorage.removeItem(PERIOD_SUMMARY_EDITED_KEY);
  localStorage.removeItem(EOS_SUMMARY_EDITED_KEY);
  renderAll();
  updateMiniStatus('Generated output refreshed.');
}

function monitorWindows() {
  const shiftDate = $('shiftDate').value || new Date().toISOString().slice(0, 10);
  const [y, m, d] = shiftDate.split('-').map(Number);
  const next = addDays(y, m, d, 1);
  const includeMET = $('useMET').value === 'true';

  const make = (key, label, sd, sh, sm, ed, eh, em) => ({
    key,
    label,
    display: `${label} MP ${String(sh - 2).padStart(2, '0')}:${String(sm).padStart(2, '0')} to ${String(eh - 2 < 0 ? eh + 22 : eh - 2).padStart(2, '0')}:${String(em).padStart(2, '0')}`,
    start: zonedTimeToUtc(sd.y, sd.m, sd.d, sh, sm),
    end: zonedTimeToUtc(ed.y, ed.m, ed.d, eh, em)
  });

  const windows = {
    full: make('full', 'Full', { y, m, d }, 19, 0, next, includeMET ? 6 : 5, 30),
    p1: make('p1', 'P1', { y, m, d }, 19, 0, { y, m, d }, 23, 0),
    p2: make('p2', 'P2', { y, m, d }, 23, 30, next, 2, 30),
    p3: make('p3', 'P3', next, 3, 0, next, 5, 30),
    met: make('met', 'MET', next, 5, 30, next, 6, 30)
  };

  return windows;
}

function buildFlUtilUrl(windowKey = 'full') {
  const win = monitorWindows()[windowKey] || monitorWindows().full;
  const u = new URL('https://monitorportal.amazon.com/igraph');
  const patterns = [
    'dataset=$Prod$ schemaname=Service marketplace=$RFD2-MainSorter1Controller$ hostgroup=$ALL$ host=$ALL$ servicename=$WarehouseControlService$ methodname=$SortationOrchestrator.divert$ client=$ALL$ metricclass=$NONE$ instance=$NONE$ schemaname=Service metric=$finalActualDestination-MP AND :SUCCESS$',
    'dataset=$Prod$ schemaname=Service marketplace=$RFD2-MainSorter1Controller$ hostgroup=$ALL$ host=$ALL$ servicename=$WarehouseControlService$ methodname=$SortationOrchestrator.divert$ client=$ALL$ metricclass=$NONE$ instance=$NONE$ schemaname=Service metric=$finalActualDestination-FL AND :SUCCESS$',
    'dataset=$Prod$ schemaname=Service marketplace=$RFD2-MainSorter1Controller$ hostgroup=$ALL$ host=$ALL$ servicename=$WarehouseControlService$ methodname=$SortationOrchestrator.divert$ client=$ALL$ metricclass=$NONE$ instance=$NONE$ schemaname=Service metric=$finalActualDestination-RP AND :SUCCESS$'
  ];

  patterns.forEach((pattern, i) => {
    const n = i + 1;
    u.searchParams.set(`SchemaName${n}`, 'Search');
    u.searchParams.set(`Pattern${n}`, pattern);
  });

  u.searchParams.set('Period1', 'OneMinute');
  u.searchParams.set('Stat1', 'sum');
  u.searchParams.set('HeightInPixels', '300');
  u.searchParams.set('WidthInPixels', '600');
  u.searchParams.set('GraphTitle', `FL Utilization - ${win.label}`);
  u.searchParams.set('DecoratePoints', 'true');
  u.searchParams.set('GraphType', 'pie');
  u.searchParams.set('TZ', 'US/Pacific@TZ: Pacific');
  u.searchParams.set('StartTime1', isoNoMs(win.start));
  u.searchParams.set('EndTime1', isoNoMs(win.end));
  u.searchParams.set('FunctionExpression1', 'SUM(S1)');
  u.searchParams.set('FunctionLabel1', 'TOTAL MP[total: {sum}]');
  u.searchParams.set('FunctionYAxisPreference1', 'left');
  u.searchParams.set('FunctionExpression2', 'SUM(S2)');
  u.searchParams.set('FunctionLabel2', 'TOTAL FL[total: {sum}]');
  u.searchParams.set('FunctionYAxisPreference2', 'left');
  u.searchParams.set('FunctionExpression3', 'SUM(S3)');
  u.searchParams.set('FunctionLabel3', 'TOTAL RWC[total: {sum}]');
  u.searchParams.set('FunctionYAxisPreference3', 'left');
  return monitorUrlString(u);
}

function buildBattleBeltUrl(windowKey = 'full') {
  const win = monitorWindows()[windowKey] || monitorWindows().full;
  const u = new URL('https://monitorportal.amazon.com/igraph');
  const west = [350, 355, 354, 353, 352, 351, 349, 348, 347, 346, 345, 344, 343, 342, 341, 340, 339, 338];
  const east = [104, 105, 106, 107, 108, 109, 110, 111, 112, 113, 114, 115, 116, 117, 118, 119, 120, 121, 122];
  const all = ['FL', ...west.map((id) => `FL_${id}`), ...east.map((id) => `FL_${id}`)];

  all.forEach((dest, i) => {
    const n = i + 1;
    u.searchParams.set(`SchemaName${n}`, 'Search');
    u.searchParams.set(`Pattern${n}`, `dataset=$Prod$ schemaname=Service marketplace=$RFD2-MainSorter1Controller$ hostgroup=$ALL$ host=$ALL$ servicename=$WarehouseControlService$ methodname=$SortationOrchestrator.divert$ client=$ALL$ metricclass=$NONE$ instance=$NONE$ schemaname=Service metric=$actDestStatus-${dest} AND :SUCCESS$`);
  });

  u.searchParams.set('Period1', 'FiveMinute');
  u.searchParams.set('Stat1', 'sum');
  u.searchParams.set('HeightInPixels', '500');
  u.searchParams.set('WidthInPixels', '1460');
  u.searchParams.set('GraphTitle', `Battle of the Belt II (Successful Divert) - ${win.label}`);
  u.searchParams.set('DecoratePoints', 'true');
  u.searchParams.set('GraphType', 'pie');
  u.searchParams.set('TZ', 'US/Pacific@TZ: Pacific');
  u.searchParams.set('LabelLeft', 'Total Number of Totes');
  u.searchParams.set('StartTime1', isoNoMs(new Date(win.start.getTime() + 5 * 60000)));
  u.searchParams.set('EndTime1', isoNoMs(win.end));
  u.searchParams.set('FunctionExpression1', 'SUM(S2,S3,S4,S5,S6,S7,S8,S9,S10,S11,S12,S13,S14,S15,S16,S17,S18,S19)');
  u.searchParams.set('FunctionLabel1', '{West Side}');
  u.searchParams.set('FunctionYAxisPreference1', 'left');
  u.searchParams.set('FunctionExpression2', 'SUM(S20,S21,S22,S23,S24,S25,S26,S27,S28,S29,S30,S31,S32,S33,S34,S35,S36,S37,S38)');
  u.searchParams.set('FunctionLabel2', '{East Side}');
  u.searchParams.set('FunctionYAxisPreference2', 'left');
  return monitorUrlString(u);
}

function openMonitorUrl(type, windowKey) {
  const url = type === 'belt' ? buildBattleBeltUrl(windowKey) : buildFlUtilUrl(windowKey);
  window.open(url, '_blank', 'noopener,noreferrer');
}

function copyMonitorUrl(type, windowKey) {
  const url = type === 'belt' ? buildBattleBeltUrl(windowKey) : buildFlUtilUrl(windowKey);
  navigator.clipboard.writeText(url);
  updateMiniStatus('MonitorPortal URL copied.');
}

function embeddedMonitorPeriod() {
  const selected = $('embeddedMonitorPeriod')?.value || 'p1';
  if (selected === 'met' && $('useMET').value !== 'true') return 'p3';
  return selected;
}

function loadEmbeddedMonitor(type) {
  const period = embeddedMonitorPeriod();
  openMonitorUrl(type, period);
  updateMiniStatus(`${type === 'belt' ? 'Battle of the Belt' : 'FL Utilization'} opened for ${period.toUpperCase()}.`);
}

async function requestBridgePull() {
  window.postMessage({ type: 'PRC_V2_HYBRID_PULL_REQUEST' }, '*');
  try {
    const res = await fetch(SERVER_BRIDGE_URL);
    if (res.ok && res.status !== 204) {
      const json = await res.json();
      if (json?.payload && hasUsableBridgeData(json.payload)) {
        lastServerBridgeTs = json.receivedAt || Date.now();
        importBridgePayload(json.payload, 'Bridge data imported.');
        return;
      }
    }
  } catch {}
  const imported = importStoredBridgePayload('Stored bridge data imported.');
  if (!imported) updateMiniStatus('Bridge pull requested. No stored data yet.');
  setTimeout(() => importStoredBridgePayload('Bridge data refreshed.'), 600);
}

function pullPeriodsForShift() {
  const includeMET = $('useMET')?.value === 'true';
  return includeMET ? ['full', 'p1', 'p2', 'p3', 'met'] : ['full', 'p1', 'p2', 'p3'];
}

function bridgePullRequestPayload(source) {
  const includeMET = $('useMET')?.value === 'true';
  return {
    source,
    periods: pullPeriodsForShift(),
    shiftDate: $('shiftDate')?.value || defaultShiftDateString(),
    includeMET
  };
}

function requestBridgeSourcePull(source = 'all', trigger = 'manual') {
  const payload = bridgePullRequestPayload(source);
  window.postMessage({
    type: 'PRC_V2_HYBRID_SOURCE_PULL',
    ...payload
  }, '*');
  const label = trigger === 'auto'
    ? `Auto ${bridgeSourceLabel(source)} refresh requested.`
    : `${bridgeSourceLabel(source)} pull requested.`;
  updateMiniStatus(label);
  setAutoFclmStatus(label, 'good');
  startBridgeRefreshPoll(`${bridgeSourceLabel(source)} bridge data refreshed.`);
}

function requestFclmPull(source = 'manual') {
  const includeMET = $('useMET')?.value === 'true';
  const periods = pullPeriodsForShift();
  window.postMessage({
    type: 'PRC_V2_HYBRID_FCLM_PULL',
    periods,
    shiftDate: $('shiftDate')?.value || defaultShiftDateString(),
    includeMET,
    includeMonitor: true
  }, '*');
  const label = source === 'auto'
    ? 'Auto FCLM + flow refresh requested.'
    : 'FCLM, FL Utilization, and Battle of the Belt pull requested.';
  updateMiniStatus(label);
  setAutoFclmStatus(label, 'good');
  startBridgeRefreshPoll('FCLM and flow bridge data refreshed.');
}

function setAutoFclmStatus(message, cls = '') {
  const el = $('autoFclmStatus');
  if (!el) return;
  el.textContent = message;
  el.classList.remove('good', 'warn');
  if (cls) el.classList.add(cls);
}

function syncPanelCollapseLabel(panel, selector = '.panel-collapse-toggle') {
  const label = panel?.querySelector(selector);
  if (!panel || !label) return;
  label.textContent = panel.open ? 'Collapse' : 'Expand';
}

function configurePanelCollapse(panelId, storageKey) {
  const panel = $(panelId);
  if (!panel) return;
  panel.addEventListener('toggle', () => {
    localStorage.setItem(storageKey, String(!panel.open));
    syncPanelCollapseLabel(panel);
  });
  syncPanelCollapseLabel(panel);
}

function syncFclmSourceCollapseLabel() {
  syncPanelCollapseLabel($('fclmSourcePanel'));
}

function configureFclmSourceCollapse() {
  configurePanelCollapse('fclmSourcePanel', FCLM_SOURCE_COLLAPSE_KEY);
}

function configurePeriodChecklistCollapse() {
  configurePanelCollapse('periodChecklistPanel', PERIOD_CHECKLIST_COLLAPSE_KEY);
}

function configurePaceStatusCollapse() {
  configurePanelCollapse('paceStatusPanel', PACE_STATUS_COLLAPSE_KEY);
}

function configureFclmAutoRefresh(runNow = false) {
  if (fclmAutoRefreshTimer) {
    clearInterval(fclmAutoRefreshTimer);
    fclmAutoRefreshTimer = null;
  }

  const minutes = num($('autoFclmRefresh')?.value);
  if (!minutes) {
    setAutoFclmStatus('Auto refresh is off.', 'warn');
    return;
  }

  setAutoFclmStatus(`Auto refresh active: every ${minutes} min — FCLM, FL Utilization, and Belt pull in background.`, 'good');
  fclmAutoRefreshTimer = setInterval(() => {
    renderFclmSourceLinks();
    requestFclmPull('auto');
  }, minutes * 60 * 1000);

  if (runNow) {
    renderFclmSourceLinks();
    requestFclmPull('auto');
  }
}

function fclmSourcePeriods() {
  const rows = [
    { key: 'full', label: 'Full Shift' },
    { key: 'p1', label: 'P1' },
    { key: 'p2', label: 'P2' },
    { key: 'p3', label: 'P3' }
  ];
  if ($('useMET')?.value === 'true') rows.push({ key: 'met', label: 'MET' });
  return rows;
}

function renderFclmSourceLinks() {
  const el = $('fclmSourceLinks');
  if (!el) return;

  el.innerHTML = fclmSourcePeriods().map((period) => {
    const url = buildFclmUrl(period.key);
    return `
      <div class="source-link-card">
        <div class="source-link-name">${escapeHtml(period.label)}</div>
        <div class="source-link-url" title="${escapeHtml(url)}">${escapeHtml(url)}</div>
        <button class="soft" data-fclm-source-open="${escapeHtml(period.key)}">Open</button>
        <button class="soft" data-fclm-source-copy="${escapeHtml(period.key)}">Copy</button>
      </div>
    `;
  }).join('');
}

function copyFclmUrl(period) {
  const url = buildFclmUrl(period);
  if (!url) return;
  navigator.clipboard.writeText(url);
  updateMiniStatus(`FCLM ${String(period).toUpperCase()} source URL copied.`);
}

function renderMonitorLinks() {
  const wins = monitorWindows();
  const periods = activePeriods().map((p) => wins[p.key]);
  const periodEl = $('monitorPeriodLinks');
  const flEl = $('monitorFlLinks');
  const beltEl = $('monitorBeltLinks');

  if (periodEl) {
    periodEl.innerHTML = `
      <div class="monitor-note">Times display two hours behind in MonitorPortal. Example: MP 17:00 to 21:00 maps to 19:00 to 23:00 CT.</div>
      ${periods.map((win) => `
        <button data-monitor-type="fl" data-monitor-window="${win.key}">${win.label} FL / MP / RWC<br>${win.display}</button>
        <button class="copy-link" data-monitor-copy="fl" data-monitor-window="${win.key}">Copy ${win.label} FL URL</button>
        <button data-monitor-type="belt" data-monitor-window="${win.key}">${win.label} East vs West<br>${win.display}</button>
        <button class="copy-link" data-monitor-copy="belt" data-monitor-window="${win.key}">Copy ${win.label} Belt URL</button>
      `).join('')}
    `;
  }

  if (flEl) {
    flEl.innerHTML = `
      <div class="monitor-note">Full-window FL Utilization pie for MP, FL, RWC, and total capture mix.</div>
      <button class="wide primary" data-monitor-type="fl" data-monitor-window="full">Open Full FL / MP / RWC Window<br>${wins.full.display}</button>
      <button class="wide copy-link" data-monitor-copy="fl" data-monitor-window="full">Copy Full FL / MP / RWC URL</button>
      ${periods.map((win) => `<button data-monitor-type="fl" data-monitor-window="${win.key}">${win.label} only</button>`).join('')}
    `;
  }

  if (beltEl) {
    beltEl.innerHTML = `
      <div class="monitor-note">Full-window Battle of the Belt pie split between East side and West side.</div>
      <button class="wide primary" data-monitor-type="belt" data-monitor-window="full">Open Full East vs West Window<br>${wins.full.display}</button>
      <button class="wide copy-link" data-monitor-copy="belt" data-monitor-window="full">Copy Full East vs West URL</button>
      ${periods.map((win) => `<button data-monitor-type="belt" data-monitor-window="${win.key}">${win.label} only</button>`).join('')}
    `;
  }
}

function bind() {
  document.addEventListener('input', (e) => {
    if (e.target.id === 'periodSummary') {
      periodSummaryEdited = true;
      localStorage.setItem(PERIOD_SUMMARY_EDITED_KEY, 'true');
      saveState();
      return;
    }
    if (e.target.id === 'eosSummary') {
      eosSummaryEdited = true;
      localStorage.setItem(EOS_SUMMARY_EDITED_KEY, 'true');
      saveState();
      return;
    }
    if (e.target.id === 'generatedCopyBlock') {
      generatedCopyEdited = true;
      localStorage.setItem(COPY_BLOCK_EDITED_KEY, 'true');
      saveState();
      return;
    }
    if (shouldManualLockInput(e.target)) markManualLock(e.target.id);
    if (e.target.matches('input, select, textarea')) renderAll();
  });

  $('themeSelect').addEventListener('change', (e) => applyTheme(e.target.value));
  $('focusMode').addEventListener('change', (e) => applyFocus(e.target.value));
  document.querySelectorAll('[data-view-tab]').forEach((tab) => {
    tab.addEventListener('click', () => applyView(tab.dataset.viewTab));
  });

  $('toggleTopBtn').addEventListener('click', () => {
    document.body.classList.toggle('top-min');
    const isMin = document.body.classList.contains('top-min');
    $('toggleTopBtn').textContent = isMin ? 'Expand' : 'Minimize';
    localStorage.setItem(TOP_KEY, String(isMin));
  });

  on('saveBtn', 'click', saveBoardAndLog);
  on('resetShiftBtn', 'click', resetShift);
  on('protectManualOverrides', 'change', () => {
    saveState(false);
    updateManualOverrideStatus();
  });
  on('clearManualOverridesBtn', 'click', clearManualLocks);
  on('pullBridgeBtn', 'click', importBridge);
  on('copySummaryTopBtn', 'click', (e) => { navigator.clipboard.writeText($('eosSummary').value); flashCopy(e.currentTarget); });
  on('pullBridgeBtn2', 'click', importBridge);
  on('importBridgeBtn', 'click', importBridge);
  on('exportStateBtn', 'click', exportState);
  on('copyPeriodSummaryBtn', 'click', (e) => { navigator.clipboard.writeText($('periodSummary').value); flashCopy(e.currentTarget); });
  on('copyEOSBtn', 'click', (e) => { navigator.clipboard.writeText($('eosSummary').value); flashCopy(e.currentTarget); });
  on('copyGeneratedBlockBtn', 'click', (e) => { navigator.clipboard.writeText($('generatedCopyBlock').value || ''); flashCopy(e.currentTarget); });
  on('refreshGeneratedBlockBtn', 'click', refreshGeneratedCopyBlock);
  on('refreshOutputBtn', 'click', refreshGeneratedOutput);
  on('saveShiftLogBtn', 'click', () => saveCurrentShiftResults(false));
  on('updateShiftLogBtn', 'click', updateCurrentShiftResults);
  on('copyWeekLogBtn', 'click', (e) => { copyWeekLog(); flashCopy(e.currentTarget); });
  on('importShiftLogBtn', 'click', () => $('shiftLogFileInput')?.click());
  on('shiftLogFileInput', 'change', (event) => {
    importShiftLogsFile(event.target.files?.[0]);
    event.target.value = '';
  });
  on('exportShiftLogBtn', 'click', exportShiftLogs);
  on('clearShiftLogBtn', 'click', clearShiftLog);
  on('saveXbeltLogBtn', 'click', saveCurrentXbeltEvents);
  on('copyXbeltLogBtn', 'click', (e) => { copyXbeltLog(); flashCopy(e.currentTarget); });
  on('clearXbeltLogBtn', 'click', clearXbeltLog);
  on('copyBoardBtn', 'click', (e) => {
    const text = `FULL BOARD SUMMARY\n${$('periodSummary').value}\n\n${$('eosSummary').value}`;
    navigator.clipboard.writeText(text);
    flashCopy(e.currentTarget);
  });
  on('toggleGeneratedBlockBtn', 'click', toggleGeneratedCopyBlock);
  on('toggleNotesWashBtn', 'click', toggleNotesWash);

  on('openNeoBtn', 'click', openNeoPlanning);
  on('openFluidRosterBtn', 'click', openFluidRoster);
  on('openFluidRosterGoalBtn', 'click', openFluidRoster);
  on('openFclmFullBtn', 'click', () => openFclmPeriod('full'));
  on('openFclmP1Btn', 'click', () => openFclmPeriod('p1'));
  on('openFclmP2Btn', 'click', () => openFclmPeriod('p2'));
  on('openFclmP3Btn', 'click', () => openFclmPeriod('p3'));
  on('openFclmMetBtn', 'click', () => openFclmPeriod('met'));
  on('pullFclmOnlyBtn', 'click', () => requestBridgeSourcePull('fclm'));
  on('pullFlUtilBtn', 'click', () => requestBridgeSourcePull('flUtil'));
  on('pullBattleBeltBtn', 'click', () => requestBridgeSourcePull('belt'));
  on('pullFclmPeriodsBtn', 'click', requestFclmPull);
  on('autoFclmRefresh', 'change', () => {
    saveState(false);
    configureFclmAutoRefresh(true);
  });
  on('refreshFclmSourcesBtn', 'click', () => {
    renderFclmSourceLinks();
    updateMiniStatus('FCLM source URLs refreshed.');
    setAutoFclmStatus('FCLM source URLs refreshed.', 'good');
  });
  on('loadEmbeddedFlBtn', 'click', () => loadEmbeddedMonitor('fl'));
  on('loadEmbeddedBeltBtn', 'click', () => loadEmbeddedMonitor('belt'));
  on('loadEmbeddedBothBtn', 'click', () => {
    loadEmbeddedMonitor('fl');
    loadEmbeddedMonitor('belt');
  });
  on('collectMonitorBridgeBtn', 'click', requestBridgePull);

  document.addEventListener('click', (event) => {
    const btn = event.target.closest('[data-monitor-type][data-monitor-window]');
    if (!btn) return;
    openMonitorUrl(btn.dataset.monitorType, btn.dataset.monitorWindow);
  });

  document.addEventListener('click', (event) => {
    const btn = event.target.closest('[data-monitor-copy][data-monitor-window]');
    if (!btn) return;
    copyMonitorUrl(btn.dataset.monitorCopy, btn.dataset.monitorWindow);
  });

  document.addEventListener('click', (event) => {
    const btn = event.target.closest('[data-pace-stream]');
    if (!btn) return;
    localStorage.setItem(PACE_STREAM_KEY, btn.dataset.paceStream);
    renderAll();
  });

  document.addEventListener('click', (event) => {
    const openBtn = event.target.closest('[data-fclm-source-open]');
    if (openBtn) {
      openFclmPeriod(openBtn.dataset.fclmSourceOpen);
      return;
    }
    const copyBtn = event.target.closest('[data-fclm-source-copy]');
    if (copyBtn) copyFclmUrl(copyBtn.dataset.fclmSourceCopy);
  });

  document.addEventListener('click', (event) => {
    const copyBtn = event.target.closest('#copyProjectionUpdateBtn');
    if (!copyBtn) return;
    const text = $('projectionUpdateText')?.textContent || '';
    navigator.clipboard.writeText(text);
    updateMiniStatus('Projection update note copied.');
    flashCopy(copyBtn);
  });

  window.addEventListener('message', (event) => {
    if (event.data?.type === 'PRC_V2_HYBRID_RESET_DASHBOARD') {
      const shift = event.data.payload?.shift || {};
      const targetDate = shift.shiftDate || resetShiftDateTarget($('shiftDate').value);
      clearWorkingShift(
        targetDate,
        !!shift.includeMET,
        `Reset working shift for next day: ${targetDate}${shift.includeMET ? ' with MET on.' : '.'}`
      );
      return;
    }
    if (event.data?.type !== 'PRC_V2_HYBRID_DATA') return;
    importBridgePayload(event.data.payload || {}, 'Hybrid bridge pulled.');
  });
}

function renderAll() {
  updateMetUi();
  updateManualOverrideStatus();
  renderGoals();
  const rows = plan();
  updateDowntimeVisibility(rows);
  const full = renderFullShiftJplh(rows);
  const board = renderBoard(rows);
  renderSnapshot(full, board);
  renderHourlyProjection(rows);
  renderPeriodPulse(rows, board);
  renderBoardBreakout(rows, board);
  renderPeriodChecklist(rows);
  renderCharts(board);
  renderMonitorLinks();
  renderFclmSourceLinks();
  buildSummaries(board, full);
  renderShiftLog(board, full);
  renderOperationsInsights(board, full);
  updateShiftProgressBar(rows);
  renderBridgeSourceAges();
  renderLiveBridgeStatus();
  saveState(false);
}

function init() {
  $('shiftDate').value = defaultShiftDateString();
  buildPeriodRows();
  loadState();
  loadManualLocks();
  generatedCopyEdited = localStorage.getItem(COPY_BLOCK_EDITED_KEY) === 'true';
  periodSummaryEdited = localStorage.getItem(PERIOD_SUMMARY_EDITED_KEY) === 'true';
  eosSummaryEdited = localStorage.getItem(EOS_SUMMARY_EDITED_KEY) === 'true';
  applyTheme($('themeSelect').value || localStorage.getItem(THEME_KEY) || 'midnight');
  applyFocus($('focusMode').value || localStorage.getItem(FOCUS_KEY) || 'false');
  const requestedView = new URLSearchParams(window.location.search).get('view');
  applyView(requestedView || document.body.dataset.startView || localStorage.getItem(VIEW_KEY) || 'overview');

  const topMin = localStorage.getItem(TOP_KEY) === 'true';
  if (topMin) {
    document.body.classList.add('top-min');
    $('toggleTopBtn').textContent = 'Expand';
  }

  const copyBlockMin = localStorage.getItem(COPY_BLOCK_KEY) === 'true';
  if (copyBlockMin) {
    $('generatedBlockWrap')?.classList.add('hidden');
    $('toggleGeneratedBlockBtn').textContent = 'Expand';
  }

  const notesWashMin = localStorage.getItem(NOTES_WASH_KEY) === 'true';
  if (notesWashMin) {
    $('notesWashWrap')?.classList.add('hidden');
    if ($('toggleNotesWashBtn')) $('toggleNotesWashBtn').textContent = 'Expand';
  }

  const fclmSourceCollapsed = localStorage.getItem(FCLM_SOURCE_COLLAPSE_KEY) === 'true';
  if (fclmSourceCollapsed && $('fclmSourcePanel')) {
    $('fclmSourcePanel').open = false;
  }

  const periodChecklistCollapsed = localStorage.getItem(PERIOD_CHECKLIST_COLLAPSE_KEY) === 'true';
  if (periodChecklistCollapsed && $('periodChecklistPanel')) {
    $('periodChecklistPanel').open = false;
  }

  const paceStatusCollapsed = localStorage.getItem(PACE_STATUS_COLLAPSE_KEY) === 'true';
  if (paceStatusCollapsed && $('paceStatusPanel')) {
    $('paceStatusPanel').open = false;
  }

  bind();
  configureFclmSourceCollapse();
  configurePeriodChecklistCollapse();
  configurePaceStatusCollapse();
  renderAll();
  configureFclmAutoRefresh(true);
  startServerBridgePoll();
  updateLiveClock();
  setInterval(updateLiveClock, 10000);
  setInterval(() => { renderBridgeSourceAges(); renderLiveBridgeStatus(); }, 5000);
}

init();
