/**
 * Log view — live MQTT message and system event log
 */

const LOG_PAGE_SIZE = 200;

// ─── Payload expansion maps ───────────────────────────────────────────────────

/** Short key → human-readable field name */
const KEY_NAMES = {
  act:  'action',
  clr:  'colour',
  brt:  'brightness',
  pat:  'pattern',
  dur:  'duration',
  vol:  'volume',
  aud:  'audio',
  rpt:  'loops',
  nod:  'node',
  fle:  'file',
  sig:  'signal',
  frq:  'frequency',
  ver:  'version',
  sts:  'status',
  sta:  'status',
  oled: 'oledLevel',
  gate: 'gateway',
  mask: 'subnetMask',
  dhcp: 'dhcp',
  usb:  'usb',
  ftp:  'ftp',
};

/** Short `action` value → human-readable action name */
const ACTION_VALUES = {
  ply:    'play',
  stp:    'stop',
  ack:    'acknowledge',
  col:    'setColour',
  pat:    'setPattern',
  brt:    'setBrightness',
  volOut: 'setVolume',
  cal:    'calibrate',
  vrt:    'storeVolume',
  nod:    'setNode',
  fle:    'pullFile',
  get:    'getState',
  rbt:    'reboot',
  upd:    'firmwareUpdate',
};

/**
 * Parse a JSON payload string, expand short-form keys to long-form names,
 * expand the `action` value, and return a pretty-printed JSON string.
 * Returns the original string unchanged if it cannot be parsed.
 */
function expandPayload(raw) {
  let obj;
  try {
    obj = JSON.parse(raw);
  } catch {
    return raw; // not JSON — return as-is
  }

  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) {
    return JSON.stringify(obj, null, 2);
  }

  const expanded = {};
  for (const [k, v] of Object.entries(obj)) {
    const longKey = KEY_NAMES[k] || k;
    const expandedVal = (k === 'act' && typeof v === 'string')
      ? (ACTION_VALUES[v] || v)
      : v;
    expanded[longKey] = expandedVal;
  }

  return JSON.stringify(expanded, null, 2);
}

let logEntries = [];   // currently displayed entries
let logOffset  = 0;    // how many entries already loaded (for pagination)
let logFilters = {
  mac:        '',
  node:       '',
  showRx:     true,
  showTx:     true,
  showServer: true,
  showClient: true,
  sort:       'desc',  // 'desc' = newest first
};

// ─── Helpers ────────────────────────────────────────────────────────────────

function fmtTime(ts) {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  const ms = String(d.getMilliseconds()).padStart(3, '0');
  return `${hh}:${mm}:${ss}.${ms}`;
}

function fmtDate(ts) {
  const d = new Date(ts);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function buildQueryString() {
  const params = new URLSearchParams();

  if (logFilters.mac)  params.set('mac',  logFilters.mac.trim());
  if (logFilters.node) params.set('node', logFilters.node.trim());

  // Derive direction / category arrays from toggles
  const dirs = [];
  const cats = [];

  if (logFilters.showRx) { dirs.push('rx'); cats.push('mqtt'); }
  if (logFilters.showTx) { dirs.push('tx'); }
  // If any of rx/tx are on, mqtt category must be included
  if (!logFilters.showRx && !logFilters.showTx) {
    // No MQTT — still allow sys entries if server/client are on
  }
  if (logFilters.showServer) { dirs.push('sys'); cats.push('server'); }
  if (logFilters.showClient) {
    if (!dirs.includes('sys')) dirs.push('sys');
    cats.push('client');
  }

  // If nothing is enabled, there's nothing to show
  if (dirs.length === 0) return null;

  params.set('direction', [...new Set(dirs)].join(','));
  params.set('category',  [...new Set(cats)].join(','));
  params.set('sort',  logFilters.sort);
  params.set('limit', String(LOG_PAGE_SIZE));
  params.set('offset', String(logOffset));

  return params.toString();
}

function passesFilters(entry) {
  if (entry.direction === 'rx' && !logFilters.showRx) return false;
  if (entry.direction === 'tx' && !logFilters.showTx) return false;
  if (entry.direction === 'sys') {
    if (entry.category === 'server' && !logFilters.showServer) return false;
    if (entry.category === 'client' && !logFilters.showClient) return false;
  }
  const mac  = logFilters.mac.trim();
  const node = logFilters.node.trim();
  if (mac  && !(entry.mac  && entry.mac.includes(mac)))   return false;
  if (node && !(entry.node && entry.node.includes(node)))  return false;
  return true;
}

// ─── Entry DOM builder ───────────────────────────────────────────────────────

function makeEntryEl(entry) {
  const el = document.createElement('div');
  el.className = 'log-entry';
  el.dataset.id = entry.id;

  // Header row: time + badges
  const header = document.createElement('div');
  header.className = 'log-entry-header';

  const time = document.createElement('span');
  time.className = 'log-time';
  time.textContent = fmtTime(entry.ts);
  time.title = new Date(entry.ts).toLocaleString();
  header.appendChild(time);

  // Direction badge
  const dirBadge = document.createElement('span');
  dirBadge.className = `log-badge log-badge-${entry.direction}`;
  dirBadge.textContent = entry.direction.toUpperCase();
  header.appendChild(dirBadge);

  // Category badge
  const catBadge = document.createElement('span');
  catBadge.className = `log-badge log-badge-cat-${entry.category}`;
  catBadge.textContent = entry.category.toUpperCase();
  header.appendChild(catBadge);

  // MAC / node / topic inline
  if (entry.mac) {
    const mac = document.createElement('span');
    mac.className = 'log-meta';
    mac.textContent = entry.mac;
    header.appendChild(mac);
  }
  if (entry.node) {
    const node = document.createElement('span');
    node.className = 'log-meta log-meta-node';
    node.textContent = entry.node;
    header.appendChild(node);
  }

  el.appendChild(header);

  // Topic line (for MQTT entries)
  if (entry.topic) {
    const topicEl = document.createElement('div');
    topicEl.className = 'log-topic';
    topicEl.textContent = entry.topic;
    el.appendChild(topicEl);
  }

  // Payload line
  if (entry.payload) {
    const payloadEl = document.createElement('div');
    payloadEl.className = 'log-payload';

    let displayText;
    if (entry.direction === 'sys') {
      // sys entries: plain string or JSON — pretty-print JSON, leave strings as-is
      try {
        const obj = JSON.parse(entry.payload);
        if (obj && typeof obj === 'object') {
          displayText = JSON.stringify(obj, null, 2);
        } else {
          displayText = entry.payload;
        }
      } catch {
        displayText = entry.payload;
      }
    } else {
      // MQTT rx/tx — expand short keys and pretty-print
      displayText = expandPayload(entry.payload);
    }

    const TRUNCATE = 300;
    if (displayText.length > TRUNCATE) {
      const short = document.createElement('span');
      short.textContent = displayText.slice(0, TRUNCATE) + '…';

      const toggle = document.createElement('button');
      toggle.className = 'log-expand-btn';
      toggle.textContent = 'more';
      toggle.addEventListener('click', () => {
        short.textContent = displayText;
        toggle.remove();
      });

      payloadEl.appendChild(short);
      payloadEl.appendChild(toggle);
    } else {
      payloadEl.textContent = displayText;
    }

    el.appendChild(payloadEl);
  }

  return el;
}

// ─── Render ─────────────────────────────────────────────────────────────────

function renderLogList() {
  const list = document.getElementById('log-entry-list');
  if (!list) return;
  list.innerHTML = '';

  if (logEntries.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'log-empty';
    empty.textContent = 'No log entries match the current filters.';
    list.appendChild(empty);
    return;
  }

  // Group consecutive same-day entries under a date separator
  let lastDate = null;
  const frag = document.createDocumentFragment();

  for (const entry of logEntries) {
    const date = fmtDate(entry.ts);
    if (date !== lastDate) {
      lastDate = date;
      const sep = document.createElement('div');
      sep.className = 'log-date-sep';
      sep.textContent = date;
      frag.appendChild(sep);
    }
    frag.appendChild(makeEntryEl(entry));
  }

  list.appendChild(frag);

  // Load-more button
  const moreBtn = document.getElementById('log-load-more');
  if (moreBtn) moreBtn.hidden = (logEntries.length < LOG_PAGE_SIZE + logOffset - LOG_PAGE_SIZE);
}

function updateLoadMoreVisibility(fetchedCount) {
  const moreBtn = document.getElementById('log-load-more');
  if (moreBtn) moreBtn.hidden = fetchedCount < LOG_PAGE_SIZE;
}

// ─── Fetch ───────────────────────────────────────────────────────────────────

async function fetchLog(append = false) {
  if (!append) logOffset = 0;

  const qs = buildQueryString();
  if (!qs) {
    logEntries = [];
    renderLogList();
    return;
  }

  try {
    const res = await fetch(`/api/log?${qs}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const fetched = data.entries || [];

    if (append) {
      logEntries = logEntries.concat(fetched);
    } else {
      logEntries = fetched;
    }
    logOffset = logEntries.length;
    renderLogList();
    updateLoadMoreVisibility(fetched.length);
  } catch (err) {
    console.error('Failed to fetch log:', err);
  }
}

// ─── Live update ─────────────────────────────────────────────────────────────

export function handleLogEntry(entry) {
  if (!passesFilters(entry)) return;

  if (logFilters.sort === 'desc') {
    // Newest first — prepend
    logEntries.unshift(entry);
    const list = document.getElementById('log-entry-list');
    if (list) {
      // Remove "no entries" placeholder if present
      const empty = list.querySelector('.log-empty');
      if (empty) empty.remove();

      // Insert after any date separator at the very top
      const firstChild = list.firstChild;
      const entryEl = makeEntryEl(entry);
      const date = fmtDate(entry.ts);

      // Check if a date separator for today already exists at the top
      const topSep = list.querySelector('.log-date-sep');
      if (!topSep || topSep.textContent !== date) {
        const sep = document.createElement('div');
        sep.className = 'log-date-sep';
        sep.textContent = date;
        list.insertBefore(sep, firstChild);
        list.insertBefore(entryEl, sep.nextSibling);
      } else {
        list.insertBefore(entryEl, topSep.nextSibling);
      }
    }
  } else {
    // Oldest first — append
    logEntries.push(entry);
    const list = document.getElementById('log-entry-list');
    if (list) {
      const empty = list.querySelector('.log-empty');
      if (empty) empty.remove();
      list.appendChild(makeEntryEl(entry));
    }
  }
}

// ─── Filter bar ──────────────────────────────────────────────────────────────

function syncFilterUI() {
  const setActive = (id, on) => {
    const el = document.getElementById(id);
    if (el) el.classList.toggle('active', on);
  };
  setActive('log-toggle-rx',     logFilters.showRx);
  setActive('log-toggle-tx',     logFilters.showTx);
  setActive('log-toggle-server', logFilters.showServer);
  setActive('log-toggle-client', logFilters.showClient);

  const sortBtn = document.getElementById('log-sort-btn');
  if (sortBtn) sortBtn.textContent = logFilters.sort === 'desc' ? '↓ Newest' : '↑ Oldest';
}

function wireFilterBar() {
  const macInput  = document.getElementById('log-filter-mac');
  const nodeInput = document.getElementById('log-filter-node');

  let debounceTimer = null;
  function scheduleRefresh() {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => fetchLog(false), 400);
  }

  macInput.addEventListener('input', (e) => {
    logFilters.mac = e.target.value;
    scheduleRefresh();
  });
  nodeInput.addEventListener('input', (e) => {
    logFilters.node = e.target.value;
    scheduleRefresh();
  });

  const toggles = [
    ['log-toggle-rx',     'showRx'],
    ['log-toggle-tx',     'showTx'],
    ['log-toggle-server', 'showServer'],
    ['log-toggle-client', 'showClient'],
  ];
  toggles.forEach(([id, key]) => {
    document.getElementById(id).addEventListener('click', () => {
      logFilters[key] = !logFilters[key];
      syncFilterUI();
      fetchLog(false);
    });
  });

  document.getElementById('log-sort-btn').addEventListener('click', () => {
    logFilters.sort = logFilters.sort === 'desc' ? 'asc' : 'desc';
    syncFilterUI();
    fetchLog(false);
  });

  document.getElementById('log-refresh-btn').addEventListener('click', () => {
    fetchLog(false);
  });

  document.getElementById('log-clear-btn').addEventListener('click', () => {
    logFilters.mac = '';
    logFilters.node = '';
    macInput.value  = '';
    nodeInput.value = '';
    fetchLog(false);
  });

  document.getElementById('log-load-more').addEventListener('click', () => {
    fetchLog(true);
  });
}

// ─── Build DOM ───────────────────────────────────────────────────────────────

function buildLogView() {
  const view = document.getElementById('view-log');
  view.innerHTML = '';

  // ── Filter bar (sticky) ──
  const filterBar = document.createElement('div');
  filterBar.className = 'log-filter-bar';

  // Text inputs row
  const inputRow = document.createElement('div');
  inputRow.className = 'log-filter-row';

  const macInput = document.createElement('input');
  macInput.type = 'text';
  macInput.id = 'log-filter-mac';
  macInput.placeholder = 'MAC filter…';
  macInput.className = 'log-filter-input';
  macInput.autocomplete = 'off';

  const nodeInput = document.createElement('input');
  nodeInput.type = 'text';
  nodeInput.id = 'log-filter-node';
  nodeInput.placeholder = 'Node filter…';
  nodeInput.className = 'log-filter-input';
  nodeInput.autocomplete = 'off';

  inputRow.appendChild(macInput);
  inputRow.appendChild(nodeInput);
  filterBar.appendChild(inputRow);

  // Toggle buttons row
  const toggleRow = document.createElement('div');
  toggleRow.className = 'log-filter-row log-toggle-row';

  const makeToggle = (id, label, title) => {
    const btn = document.createElement('button');
    btn.id = id;
    btn.className = 'log-toggle-btn active';
    btn.textContent = label;
    btn.title = title;
    return btn;
  };

  toggleRow.appendChild(makeToggle('log-toggle-rx',     'RX',     'Device → server MQTT messages'));
  toggleRow.appendChild(makeToggle('log-toggle-tx',     'TX',     'Server → device MQTT messages'));
  toggleRow.appendChild(makeToggle('log-toggle-server', 'Server', 'Server start/stop and MQTT broker events'));
  toggleRow.appendChild(makeToggle('log-toggle-client', 'Client', 'Browser connect/disconnect events'));

  const sortBtn = document.createElement('button');
  sortBtn.id = 'log-sort-btn';
  sortBtn.className = 'log-toggle-btn';
  sortBtn.textContent = '↓ Newest';

  const refreshBtn = document.createElement('button');
  refreshBtn.id = 'log-refresh-btn';
  refreshBtn.className = 'log-toggle-btn';
  refreshBtn.textContent = '↻';
  refreshBtn.title = 'Refresh';

  const clearBtn = document.createElement('button');
  clearBtn.id = 'log-clear-btn';
  clearBtn.className = 'log-toggle-btn';
  clearBtn.textContent = '✕';
  clearBtn.title = 'Clear filters';

  toggleRow.appendChild(sortBtn);
  toggleRow.appendChild(refreshBtn);
  toggleRow.appendChild(clearBtn);
  filterBar.appendChild(toggleRow);
  view.appendChild(filterBar);

  // ── Entry list ──
  const list = document.createElement('div');
  list.id = 'log-entry-list';
  list.className = 'log-entry-list';
  view.appendChild(list);

  // ── Load more ──
  const moreBtn = document.createElement('button');
  moreBtn.id = 'log-load-more';
  moreBtn.className = 'log-load-more-btn';
  moreBtn.textContent = 'Load older entries…';
  moreBtn.hidden = true;
  view.appendChild(moreBtn);

  // Bottom padding
  const pad = document.createElement('div');
  pad.style.height = '32px';
  view.appendChild(pad);
}

// ─── Public API ───────────────────────────────────────────────────────────────

export function initLogView() {
  buildLogView();
  wireFilterBar();
  syncFilterUI();
}

export async function refreshLog() {
  await fetchLog(false);
}
