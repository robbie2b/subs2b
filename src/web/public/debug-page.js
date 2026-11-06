// Debug page: live server log + when/what the addon was used for.
// Loaded after app.js; app.js calls startDebugPage()/stopDebugPage() when the page is shown/left.
const debugState = { names: {}, logTimer: null, usageTimer: null, lastSeq: 0, instance: '', seenLines: null, paused: false, wired: false, open: new Set(), lastUsage: null, page: 1, pageSize: 5, kinds: {}, subsyncEntries: [], subsyncPage: 1, subsyncPageSize: 5, dlEntries: [], dlPage: 1, dlPageSize: 5, openDl: new Set(), actTimer: null, actSeq: 0, actInstance: '', actSeen: null, actPaused: false, actSessions: [], provData: null, provPage: 1, provPageSize: 5 };
const PLAY_ICON = 'M8,5.14V19.14L19,12.14L8,5.14Z';
const PAUSE_ICON = 'M14,19H18V5H14M6,19H10V5H6V19Z';

function debugBase() {
  return state.uuid && isUuid(state.uuid) ? `/${state.uuid}/debug` : null;
}

// The same icons as the main menu: a server for a built-in service, a puzzle piece for an imported addon
const KIND_ICON_PATHS = {
  service: 'M13,19H14A1,1 0 0,1 15,20H22V22H15A1,1 0 0,1 14,23H10A1,1 0 0,1 9,22H2V20H9A1,1 0 0,1 10,19H11V17H4A1,1 0 0,1 3,16V12A1,1 0 0,1 4,11H20A1,1 0 0,1 21,12V16A1,1 0 0,1 20,17H13V19M4,3H20A1,1 0 0,1 21,4V8A1,1 0 0,1 20,9H4A1,1 0 0,1 3,8V4A1,1 0 0,1 4,3M9,7H10V5H9V7M9,15H10V13H9V15M5,5V7H7V5H5M5,13V15H7V13H5Z',
  addon: 'M20.5,11H19V7C19,5.89 18.1,5 17,5H13V3.5A2.5,2.5 0 0,0 10.5,1A2.5,2.5 0 0,0 8,3.5V5H4A2,2 0 0,0 2,7V10.8H3.5C5,10.8 6.2,12 6.2,13.5C6.2,15 5,16.2 3.5,16.2H2V20A2,2 0 0,0 4,22H7.8V20.5C7.8,19 9,17.8 10.5,17.8C12,17.8 13.2,19 13.2,20.5V22H17A2,2 0 0,0 19,20V16H20.5A2.5,2.5 0 0,0 23,13.5A2.5,2.5 0 0,0 20.5,11Z'
};

function kindIcon(kind) {
  if (kind !== 'service' && kind !== 'addon') return '';
  const label = kind === 'service' ? 'Service (built into subs2b)' : 'Addon (imported Stremio addon)';
  return `<span class="dbg-kind-icon ${kind}" title="${label}" aria-label="${label}">`
    + `<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="${KIND_ICON_PATHS[kind]}"/></svg></span>`;
}

function escapeHtmlDebug(text) {
  const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
  return String(text == null ? '' : text).replace(/[&<>"]/g, c => map[c]);
}

function startDebugPage() {
  if (!debugState.wired) {
    debugState.wired = true;
    try {
      const saved = parseInt(localStorage.getItem('subs2b_dbg_pagesize') || '', 10);
      if ([5, 10, 20, 50].includes(saved)) debugState.pageSize = saved;
    } catch (err) { /* storage may be blocked */ }
    const sizeSelect = document.getElementById('dbg-page-size');
    if (sizeSelect) {
      sizeSelect.value = String(debugState.pageSize);
      sizeSelect.addEventListener('change', () => {
        debugState.pageSize = parseInt(sizeSelect.value, 10) || 5;
        debugState.page = 1;
        try { localStorage.setItem('subs2b_dbg_pagesize', String(debugState.pageSize)); } catch (err) { /* ignore */ }
        renderRecent();
      });
    }
    try {
      const savedSync = parseInt(localStorage.getItem('subs2b_dbg_subsync_pagesize') || '', 10);
      if ([5, 10, 20, 50].includes(savedSync)) debugState.subsyncPageSize = savedSync;
    } catch (err) { /* storage may be blocked */ }
    const syncSelect = document.getElementById('dbg-subsync-page-size');
    if (syncSelect) {
      syncSelect.value = String(debugState.subsyncPageSize);
      syncSelect.addEventListener('change', () => {
        debugState.subsyncPageSize = parseInt(syncSelect.value, 10) || 5;
        debugState.subsyncPage = 1;
        try { localStorage.setItem('subs2b_dbg_subsync_pagesize', String(debugState.subsyncPageSize)); } catch (err) { /* ignore */ }
        renderSubsync();
      });
    }
    try {
      const savedProv = parseInt(localStorage.getItem('subs2b_dbg_prov_pagesize') || '', 10);
      if ([5, 10, 20, 50].includes(savedProv)) debugState.provPageSize = savedProv;
    } catch (err) { /* storage may be blocked */ }
    const provSelect = document.getElementById('dbg-prov-page-size');
    if (provSelect) {
      provSelect.value = String(debugState.provPageSize);
      provSelect.addEventListener('change', () => {
        debugState.provPageSize = parseInt(provSelect.value, 10) || 5;
        debugState.provPage = 1;
        try { localStorage.setItem('subs2b_dbg_prov_pagesize', String(debugState.provPageSize)); } catch (err) { /* ignore */ }
        renderProviderTable();
      });
    }
    document.getElementById('dbg-prov-prev')?.addEventListener('click', () => { debugState.provPage--; renderProviderTable(); });
    document.getElementById('dbg-prov-next')?.addEventListener('click', () => { debugState.provPage++; renderProviderTable(); });
    // download failures: the same paging as the other lists, and a click opens one
    try {
      const savedDl = parseInt(localStorage.getItem('subs2b_dbg_dl_pagesize') || '', 10);
      if ([5, 10, 20, 50].includes(savedDl)) debugState.dlPageSize = savedDl;
    } catch (err) { /* storage may be blocked */ }
    const dlSelect = document.getElementById('dbg-dl-page-size');
    if (dlSelect) {
      dlSelect.value = String(debugState.dlPageSize);
      dlSelect.addEventListener('change', () => {
        debugState.dlPageSize = parseInt(dlSelect.value, 10) || 5;
        debugState.dlPage = 1;
        try { localStorage.setItem('subs2b_dbg_dl_pagesize', String(debugState.dlPageSize)); } catch (err) { /* ignore */ }
        renderDownloads();
      });
    }
    document.getElementById('dbg-dl-prev')?.addEventListener('click', () => { debugState.dlPage--; renderDownloads(); });
    document.getElementById('dbg-dl-next')?.addEventListener('click', () => { debugState.dlPage++; renderDownloads(); });
    document.getElementById('dbg-downloads')?.addEventListener('click', event => {
      const head = event.target.closest('.dbg-req-head');
      if (!head) return;
      const item = head.parentElement;
      const key = item.dataset.key;
      const open = item.classList.toggle('open');
      if (open) debugState.openDl.add(key); else debugState.openDl.delete(key);
    });
    // live activity: the answer of every source is hidden until asked for; pause and clear like the log
    document.getElementById('dbg-act-pause')?.addEventListener('click', () => {
      debugState.actPaused = !debugState.actPaused;
      document.getElementById('dbg-act-pause-label').textContent = debugState.actPaused ? 'Resume' : 'Pause';
      document.querySelector('#dbg-act-pause-icon path').setAttribute('d', debugState.actPaused ? PLAY_ICON : PAUSE_ICON);
      document.getElementById('dbg-act-live')?.classList.toggle('paused', debugState.actPaused);
    });
    document.getElementById('dbg-act-clear')?.addEventListener('click', () => {
      debugState.actSessions = [];
      renderActivity();
    });
    document.getElementById('dbg-subsync-prev')?.addEventListener('click', () => { debugState.subsyncPage--; renderSubsync(); });
    document.getElementById('dbg-subsync-next')?.addEventListener('click', () => { debugState.subsyncPage++; renderSubsync(); });
    document.getElementById('dbg-page-prev')?.addEventListener('click', () => { debugState.page--; renderRecent(); });
    document.getElementById('dbg-page-next')?.addEventListener('click', () => { debugState.page++; renderRecent(); });
    document.getElementById('dbg-log-pause')?.addEventListener('click', () => {
      debugState.paused = !debugState.paused;
      document.getElementById('dbg-pause-label').textContent = debugState.paused ? 'Resume' : 'Pause';
      document.querySelector('#dbg-pause-icon path').setAttribute('d', debugState.paused ? PLAY_ICON : PAUSE_ICON);
      document.getElementById('dbg-live')?.classList.toggle('paused', debugState.paused);
    });
    // Open/close a request (delegated: the list is re-rendered on every refresh)
    document.getElementById('dbg-recent')?.addEventListener('click', event => {
      const head = event.target.closest('.dbg-req-head');
      if (!head) return;
      const item = head.parentElement;
      const key = item.dataset.key;
      const open = item.classList.toggle('open');
      if (open) debugState.open.add(key); else debugState.open.delete(key);
    });
    document.getElementById('dbg-rules-run')?.addEventListener('click', () => { void measureRules(); });
    // a shortened reference name opens in full with a tap (phones have no hover)
    document.getElementById('dbg-subsync')?.addEventListener('click', e => {
      const chip = e.target.closest && e.target.closest('.dbg-ref');
      if (chip) chip.classList.toggle('full');
    });
    document.getElementById('dbg-ft-toggle')?.addEventListener('click', e => { void formatTest(e.currentTarget.dataset.on !== '1'); });
    document.getElementById('dbg-log-copy')?.addEventListener('click', async () => {
      const box = document.getElementById('dbg-log');
      const label = document.getElementById('dbg-copy-label');
      if (!box || !label) return;
      const text = [...box.children].map(l => l.textContent).join('\n');
      let ok = false;
      try {
        await navigator.clipboard.writeText(text);
        ok = true;
      } catch (err) {
        // older browsers / no permission: copy through a hidden text box
        const area = document.createElement('textarea');
        area.value = text;
        area.setAttribute('readonly', '');
        area.style.position = 'fixed';
        area.style.opacity = '0';
        document.body.appendChild(area);
        area.select();
        try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
        area.remove();
      }
      label.textContent = ok ? `Copied ${box.childElementCount} lines` : 'Copy failed';
      clearTimeout(debugState.copyTimer);
      debugState.copyTimer = setTimeout(() => { label.textContent = 'Copy logs'; }, 2000);
    });
    document.getElementById('dbg-log-clear')?.addEventListener('click', () => {
      const box = document.getElementById('dbg-log');
      if (box) box.textContent = '';
    });
  }
  stopDebugPage();
  if (!debugBase()) {
    // nothing can be loaded yet: every section says why instead of "Loading..." forever
    const why = 'Save your configuration first (Install page): the debug data is tied to your addon.';
    for (const id of ['dbg-usage-summary', 'dbg-prov-summary', 'dbg-dl-summary']) {
      const el = document.getElementById(id);
      if (el) el.textContent = why;
    }
    for (const id of ['dbg-recent', 'dbg-subsync', 'dbg-downloads', 'dbg-rules', 'dbg-activity']) {
      const el = document.getElementById(id);
      if (el) el.innerHTML = `<div class="dbg-empty">${why}</div>`;
    }
    const body = document.getElementById('dbg-prov-body');
    if (body) body.innerHTML = `<tr><td colspan="10" class="dbg-empty">${why}</td></tr>`;
    const ft = document.getElementById('dbg-ft-state');
    if (ft) ft.textContent = '';
    return;
  }
  refreshUsage();
  refreshProviders();
  refreshSubsync();
  refreshDownloads();
  formatTest();
  refreshLogs();
  refreshActivity();
  debugState.logTimer = setInterval(refreshLogs, 2000);
  debugState.actTimer = setInterval(refreshActivity, 2000);
  debugState.actTick = setInterval(tickActivity, 1000);
  debugState.usageTimer = setInterval(() => { refreshUsage(); refreshProviders(); refreshSubsync(); refreshDownloads(); }, 30000);
}

function stopDebugPage() {
  clearInterval(debugState.logTimer);
  clearInterval(debugState.actTimer);
  clearInterval(debugState.actTick);
  clearInterval(debugState.usageTimer);
  debugState.logTimer = null;
  debugState.actTimer = null;
  debugState.usageTimer = null;
}

// One log line as colored pieces: dim time, level, tags like [SUBSYNC] and a few key words highlighted.
// Everything is added as text (never as HTML), so log content cannot inject markup.
function buildLogLine(raw) {
  const line = document.createElement('div');
  line.className = 'log-line';
  let rest = String(raw);

  const add = (text, cls) => {
    if (!text) return;
    const span = document.createElement('span');
    if (cls) span.className = cls;
    span.textContent = text;
    line.appendChild(span);
  };

  const m = rest.match(/^\[(\d{4}-\d\d-\d\dT[\d:.]+Z)\] \[(INFO|WARN|ERROR)\] ?/);
  if (m) {
    // the server writes UTC; shown in the viewer's own time zone, 24-hour
    const at = new Date(m[1]);
    add((isNaN(at) ? m[1].slice(11, 19) : at.toLocaleTimeString('en-GB', { hour12: false })) + ' ', 'log-time');
    add(m[2].padEnd(5) + ' ', 'log-level log-' + m[2].toLowerCase());
    line.classList.add('lvl-' + m[2].toLowerCase());
    rest = rest.slice(m[0].length);
  }

  // [TAG] pieces at the start of the message
  for (let guard = 0; guard < 3; guard++) {
    const t = rest.match(/^\[([A-Za-z0-9_ .:-]+)\] ?/);
    if (!t) break;
    const name = t[1].toUpperCase();
    let cls = 'log-tag';
    if (name === 'SUBSYNC') cls += ' log-subsync';
    else if (name === 'SUCCESS') cls += ' log-ok';
    else if (name === 'FAILED') cls += ' log-bad';
    else if (name === 'FALLBACK') cls += ' log-warn-tag';
    else if (name === 'SCORE') cls += ' log-score';
    else if (name === 'PROVIDER') cls += ' log-provider';
    add(`[${t[1]}] `, cls);
    rest = rest.slice(t[0].length);
  }

  // key words inside the message
  const parts = rest.split(/(shifted [+-]?[\d.]+ s|Request tt\S*|over budget|sending the subtitle unchanged|already aligned|no reference[^,{]*|failed|timed out|ECONNRESET|ENOTFOUND)/i);
  for (const p of parts) {
    if (!p) continue;
    if (/^shifted/i.test(p)) add(p, 'log-ok');
    else if (/^Request tt/.test(p)) add(p, 'log-request');
    else if (/^(over budget|sending the subtitle unchanged|no reference|already aligned)/i.test(p)) add(p, 'log-warn-text');
    else if (/^(failed|timed out|ECONNRESET|ENOTFOUND)/i.test(p)) add(p, 'log-bad');
    else add(p);
  }
  return line;
}

async function refreshLogs() {
  const base = debugBase();
  const box = document.getElementById('dbg-log');
  if (!base || !box || debugState.paused) return;
  try {
    const res = await fetch(`${base}/logs.json?after=${debugState.lastSeq}&instance=${encodeURIComponent(debugState.instance || '')}`);
    if (!res.ok) return;
    const data = await res.json();
    // Several server instances (Vercel) each have their own log and counter: a line is known by instance + number,
    // and another instance answering is not a restart (the text stays).
    const instance = data.instance || '';
    if (!instance && data.last < debugState.lastSeq) {
      // an older server without instance names: its counter went back to zero after a restart
      debugState.lastSeq = 0;
      box.textContent = '';
      return;
    }
    debugState.lastSeq = data.last;
    debugState.instance = instance;
    const seen = debugState.seenLines || (debugState.seenLines = new Set());
    const fresh = data.lines.filter(l => !seen.has(`${instance}:${l.seq}`));
    for (const l of fresh) seen.add(`${instance}:${l.seq}`);
    while (seen.size > 6000) seen.delete(seen.values().next().value);
    if (!fresh.length) return;
    const fragment = document.createDocumentFragment();
    for (const l of fresh) fragment.appendChild(buildLogLine(l.text));
    box.appendChild(fragment);
    while (box.childElementCount > 1500) box.removeChild(box.firstElementChild);
    if (document.getElementById('dbg-autoscroll')?.checked) box.scrollTop = box.scrollHeight;
  } catch (err) {
    // the server may be waking up; try again on the next tick
  }
}

async function refreshUsage() {
  const base = debugBase();
  if (!base) return;
  try {
    const res = await fetch(`${base}/usage.json?tz=Europe/Bucharest`);
    if (!res.ok) return;
    renderUsage(await res.json());
  } catch (err) {
    // ignore
  }
}

function renderUsage(data) {
  const summary = document.getElementById('dbg-usage-summary');
  const heat = document.getElementById('dbg-heatmap');
  const sugg = document.getElementById('dbg-suggestion');
  const recent = document.getElementById('dbg-recent');
  if (!summary || !heat || !sugg || !recent) return;

  const sinceText = data.since ? ` since ${new Date(data.since).toLocaleDateString('en-GB', { timeZone: data.tz })}` : '';
  const where = data.persistent
    ? 'Saved in the database (survives restarts).'
    : 'Kept in memory only (no database): resets on restart.';
  summary.textContent = `${data.total} request${data.total === 1 ? '' : 's'}${sinceText}. ${where} Times: ${data.tz}.`;

  const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const max = Math.max(1, ...data.byDayHour.flat());
  let html = '<div class="dbg-hm-row dbg-hm-head"><span></span>';
  for (let h = 0; h < 24; h++) html += `<span>${h}</span>`;
  html += '</div>';
  data.byDayHour.forEach((row, d) => {
    html += `<div class="dbg-hm-row"><span class="dbg-hm-day">${days[d]}</span>`;
    row.forEach((n, h) => {
      const alpha = n ? (0.2 + 0.8 * n / max).toFixed(2) : 0;
      html += `<span class="dbg-hm-cell" title="${days[d]} ${h}:00 - ${n} request${n === 1 ? '' : 's'}" style="background: rgba(124,58,237,${alpha})">${n || ''}</span>`;
    });
    html += '</div>';
  });
  html += '<div class="dbg-hm-row dbg-hm-total"><span class="dbg-hm-day">All</span>';
  data.byHour.forEach(n => { html += `<span class="dbg-hm-cell">${n || ''}</span>`; });
  html += '</div>';
  heat.innerHTML = html;

  // Suggested keep-alive window: every hour with real use, plus the hour before it (the server must already be awake)
  if (data.total < 10) {
    sugg.textContent = 'Not enough data yet for a keep-alive suggestion (needs about 10 requests, ideally 1-2 weeks).';
  } else {
    const threshold = Math.max(1, Math.round(Math.max(...data.byHour) * 0.1));
    const active = new Set();
    data.byHour.forEach((n, h) => {
      if (n >= threshold) { active.add(h); active.add((h + 23) % 24); }
    });
    const hours = [...active].sort((a, b) => a - b);
    const list = hours.length ? hours.map(h => `${h}:00`).join(', ') : 'none';
    sugg.innerHTML = `<strong>Keep-alive hours suggested by the data:</strong> ${list} <span class="dbg-muted">(${hours.length} h/day, about ${hours.length * 30} h/month)</span>`;
  }

  debugState.lastUsage = data;
  renderRecent();
}

// The request list is shown a page at a time (page size chosen at the top, remembered in this browser)
function renderRecent() {
  const data = debugState.lastUsage;
  const recent = document.getElementById('dbg-recent');
  const info = document.getElementById('dbg-page-info');
  if (!data || !recent) return;

  const total = data.recent.length;
  const pages = Math.max(1, Math.ceil(total / debugState.pageSize));
  debugState.page = Math.min(Math.max(1, debugState.page), pages);
  const from = (debugState.page - 1) * debugState.pageSize;
  const slice = data.recent.slice(from, from + debugState.pageSize);

  recent.innerHTML = slice.length
    ? slice.map(e => renderRequest(e, data.tz)).join('')
    : '<div class="dbg-empty">No requests recorded yet. Press Play on something in Stremio.</div>';
  if (info) info.textContent = total ? `${from + 1}-${from + slice.length} of ${total} · page ${debugState.page}/${pages}` : '';
  document.getElementById('dbg-page-prev').disabled = debugState.page <= 1;
  document.getElementById('dbg-page-next').disabled = debugState.page >= pages;
}

async function refreshProviders() {
  const base = debugBase();
  if (!base) return;
  try {
    const res = await fetch(`${base}/providers.json`);
    if (!res.ok) return;
    renderProviders(await res.json());
  } catch (err) {
    // ignore
  }
}

function renderProviders(data) {
  // the request list shows the same tags next to each provider
  debugState.kinds = {};
  for (const p of data.providers || []) { debugState.kinds[p.id] = p.kind; debugState.names[p.id] = p.name; }
  renderRecent();
  debugState.provData = data;
  renderProviderTable();
}

/** The services table, a page at a time like the other lists */
function renderProviderTable() {
  const data = debugState.provData;
  if (!data) return;
  const body = document.getElementById('dbg-prov-body');
  const summary = document.getElementById('dbg-prov-summary');
  if (!body || !summary) return;
  // the id of a service shows on hover (title) or, on a phone, with a tap on its name
  if (!body.dataset.idToggle) {
    body.dataset.idToggle = '1';
    body.addEventListener('click', ev => {
      const label = ev.target.closest && ev.target.closest('.dbg-prov-label');
      if (label) label.closest('.dbg-prov-name').classList.toggle('show-id');
    });
  }

  summary.textContent = data.requests
    ? `Based on the latest ${data.requests} request${data.requests === 1 ? '' : 's'} with stored details.`
    : 'No data yet. Press Play on something in Stremio.';
  if (!data.providers.length) {
    body.innerHTML = '<tr><td colspan="10" class="dbg-empty">No service has answered yet.</td></tr>';
    const none = document.getElementById('dbg-prov-page-info');
    if (none) none.textContent = '';
    return;
  }
  const total = data.providers.length;
  const pages = Math.max(1, Math.ceil(total / debugState.provPageSize));
  debugState.provPage = Math.min(Math.max(1, debugState.provPage), pages);
  const from = (debugState.provPage - 1) * debugState.provPageSize;
  const slice = data.providers.slice(from, from + debugState.provPageSize);
  const info = document.getElementById('dbg-prov-page-info');
  if (info) info.textContent = `${from + 1}-${from + slice.length} of ${total} · page ${debugState.provPage}/${pages}`;
  const prevBtn = document.getElementById('dbg-prov-prev');
  const nextBtn = document.getElementById('dbg-prov-next');
  if (prevBtn) prevBtn.disabled = debugState.provPage <= 1;
  if (nextBtn) nextBtn.disabled = debugState.provPage >= pages;

  const pct = n => `${Math.round(n * 100)}%`;
  const ms = n => (n >= 1000 ? `${(n / 1000).toFixed(1)} s` : `${n} ms`);
  const ranked = data.withRanking || 0;
  body.innerHTML = slice.map(p => {
    let status;
    if (p.lastOk === null) status = '<span class="dbg-status idle">no search yet</span>';
    else if (p.lastOk) status = '<span class="dbg-status ok">OK</span>';
    else status = `<span class="dbg-status bad" title="${escapeHtmlDebug(p.lastError || '')}">Failed</span>`;
    const rateClass = p.searches && p.successRate < 0.9 ? ' bad-text' : '';
    const wins = ranked ? `${p.wins} <span class="dbg-muted">(${pct(p.wins / ranked)})</span>` : '-';
    const inTop = ranked ? `${p.inTop} <span class="dbg-muted">(${pct(p.inTop / ranked)})</span>` : '-';
    return `<tr>`
      + `<td class="dbg-prov-name"><div class="dbg-name-row">${kindIcon(p.kind)}<span class="dbg-prov-label" title="${escapeHtmlDebug(p.id)}">${escapeHtmlDebug(p.name)}</span></div><div class="dbg-muted dbg-name-id">${escapeHtmlDebug(p.id)}</div></td>`
      + `<td>${status}</td>`
      + `<td class="${rateClass}">${p.searches ? pct(p.successRate) : '-'}<div class="dbg-muted">${p.searches ? `${p.searches - p.failures}/${p.searches}` : ''}</div></td>`
      + `<td>${p.searches ? ms(p.avgMs) : '-'}<div class="dbg-muted">${p.searches ? `max ${ms(p.maxMs)}` : ''}</div></td>`
      + `<td>${p.searches ? ms(p.medianMs) : '-'}</td>`
      + `<td>${p.searches ? p.avgFound : '-'}<div class="dbg-muted">${p.searches ? `${pct(p.emptyRate)} empty` : ''}</div></td>`
      + `<td>${wins}</td><td>${inTop}</td><td>${ranked ? Number(p.avgSent).toFixed(1) : '-'}</td>`
      + `<td>${p.avgBestScore === null ? '-' : p.avgBestScore}</td>`
      + `</tr>`;
  }).join('');
}

/** 1234 -> "1.2 s", 87 -> "87 ms" */
function fmtMsDebug(n) {
  if (typeof n !== 'number' || isNaN(n)) return '-';
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)} s` : `${Math.round(n)} ms`;
}

/** Where the time of a list went: the whole request, the search, the ranking, and each source (slowest first) */
function timingLines(d) {
  const t = d.timing;
  const providers = d.providers || [];
  let html = '';
  if (t) {
    const parts = [
      `<b>list ready in ${fmtMsDebug(t.totalMs)}</b>`,
      d.cached ? 'from the saved list (no search)' : `search ${fmtMsDebug(t.searchMs)}`,
      `ranking ${fmtMsDebug(t.scoringMs)}`
    ];
    if (t.stoppedEarly) parts.push('stopped early by the dynamic timeout');
    html += `<div class="dbg-flow">Time: ${parts.join(' · ')}</div>`;
  }
  if (providers.length) {
    const chips = providers.slice().sort((a, b) => b.ms - a.ms).map(p => {
      const state = p.waived ? ' · not waited for' : (p.ok ? '' : ' · failed');
      const cls = p.waived ? 'dbg-chip' : (p.ok ? 'dbg-chip' : 'dbg-chip dbg-bad');
      const title = p.error ? ` title="${escapeHtmlDebug(p.error)}"` : '';
      return `<span class="${cls}"${title}>${escapeHtmlDebug(p.name)} ${fmtMsDebug(p.ms)}${p.ok || p.waived ? ` · ${p.count}` : ''}${state}</span>`;
    }).join('');
    html += `<div class="dbg-flow dbg-muted">Sources (slowest first):</div><div class="dbg-sub-meta" style="margin:4px 0 8px">${chips}</div>`;
  }
  return html;
}

function renderRequest(e, tz) {
  const key = `${e.at}|${e.id}`;
  const when = new Date(e.at).toLocaleString('en-GB', { timeZone: tz, hour12: false });
  const d = e.details;
  const title = e.filename
    ? escapeHtmlDebug(e.filename)
    : `<span class="dbg-muted">File name not sent</span>`;
  const summary = d ? `${d.shown} of ${d.rawTotal} subtitles${d.timing ? ` · list ${fmtMsDebug(d.timing.totalMs)}` : ''}` : '';
  const isOpen = debugState.open.has(key);

  let body;
  if (!d) {
    body = '<div class="dbg-empty">No details were stored for this request (it is older than the Debug update).</div>';
  } else {
    const providers = Object.entries(d.rawByProvider).map(([p, n]) => `${escapeHtmlDebug(p)} ${n}`).join(' · ') || 'none';
    const flow = `Found ${d.rawTotal} (${providers}) → language ${d.afterLanguage} → after duplicates ${d.afterDedup} → ranked ${d.afterScoring} → sent ${d.shown}`;
    const sync = d.subsync ? `Subsync: ${d.subsync.triggered ? 'a timing reference was needed' : 'not needed'} (${escapeHtmlDebug(d.subsync.reason)}).` : '';
    const mode = d.usedFilename ? 'Ranked against the file name sent by the player.' : 'The player sent no file name: general-quality ranking.';
    const rowOf = t => {
      const sent = t.rank <= d.shown && !t.rejected;
      const reasons = t.reasons.map(r => `<span class="dbg-chip">${escapeHtmlDebug(r)}</span>`).join('');
      return `<div class="dbg-sub${t.rejected ? ' rejected' : ''}">`
        + `<span class="dbg-rank">${t.rejected ? '✕' : `#${t.rank}`}</span>`
        + `<div class="dbg-sub-main"><div class="dbg-sub-name">${escapeHtmlDebug(t.release) || '(no name)'}</div><div class="dbg-sub-meta">${kindIcon(debugState.kinds[t.provider])}<span class="dbg-prov">${escapeHtmlDebug(t.provider)}</span>${reasons}</div></div>`
        + `<span class="dbg-score">${t.score}</span>`
        + `<span class="dbg-sent${sent ? ' yes' : ''}">${t.rejected ? 'rejected' : sent ? 'sent' : 'not sent'}</span>`
        + `</div>`;
    };
    const kept = d.top.filter(t => !t.rejected);
    const rejected = d.top.filter(t => t.rejected);
    const rows = kept.map(rowOf).join('');
    // every rejected subtitle, with the reason (folded: there can be many)
    const rejectedBlock = rejected.length
      ? `<details class="dbg-rejected"><summary>Rejected: ${rejected.length} (other title, year or episode)</summary><div class="dbg-subs">${rejected.map(rowOf).join('')}</div></details>`
      : '';
    body = `${timingLines(d)}<div class="dbg-flow">${flow}</div><div class="dbg-flow dbg-muted">${mode} ${sync}</div><div class="dbg-subs">${rows || '<div class="dbg-empty">Nothing to rank.</div>'}</div>`
      + (kept.length < d.afterScoring ? `<div class="dbg-flow dbg-muted">Only the top ${kept.length} of ${d.afterScoring} are listed.</div>` : '')
      + rejectedBlock;
  }

  return `<div class="dbg-req${isOpen ? ' open' : ''}" data-key="${escapeHtmlDebug(key)}">`
    + `<div class="dbg-req-head"><svg class="dbg-chev" viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M8.59,16.58L13.17,12L8.59,7.41L10,6L16,12L10,18L8.59,16.58Z"/></svg>`
    + `<div class="dbg-req-title"><div class="dbg-req-file">${title}</div><div class="dbg-req-sub">${escapeHtmlDebug(e.type)} ${escapeHtmlDebug(e.id)}</div></div>`
    + `<div class="dbg-req-side"><div>${escapeHtmlDebug(when)}</div><div class="dbg-muted">${summary}</div></div></div>`
    + `<div class="dbg-req-body">${body}</div></div>`;
}

async function formatTest(on) {
  const base = debugBase();
  const state = document.getElementById('dbg-ft-state');
  const btn = document.getElementById('dbg-ft-toggle');
  if (!base || !state || !btn) return;
  try {
    const res = await fetch(`${base}/format-test.json${on === undefined ? '' : `?on=${on ? 1 : 0}`}`);
    const data = await res.json();
    state.textContent = data.on ? `on until ${new Date(data.until).toLocaleTimeString('en-GB', { hour12: false })}` : 'off';
    btn.textContent = data.on ? 'Stop test' : 'Start test';
    btn.dataset.on = data.on ? '1' : '0';
  } catch (err) {
    state.textContent = 'could not reach the server';
  }
}

async function measureRules() {
  const base = debugBase();
  const box = document.getElementById('dbg-rules');
  if (!base || !box) return;
  box.innerHTML = '<div class="dbg-empty">Measuring…</div>';
  try {
    const res = await fetch(`${base}/rules.json`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (!data.requests) {
      box.innerHTML = '<div class="dbg-empty">No stored request with a file name yet.</div>';
      return;
    }
    box.innerHTML = `<div class="dbg-flow dbg-muted">${data.requests} request(s) with a file name measured.</div>`
      + data.rules.map(r => {
        const share = r.evaluated ? Math.round((r.changed / r.evaluated) * 100) : 0;
        const examples = r.examples.map(x => `<div class="dbg-req-sub">${escapeHtmlDebug(x.file)}<br>now: <b>${escapeHtmlDebug(x.now)}</b><br>${r.on ? 'without' : 'with'} the rule: <b>${escapeHtmlDebug(x.flipped)}</b></div>`).join('');
        return `<div class="dbg-req open"><div class="dbg-req-head" style="cursor:default">`
          + `<div class="dbg-req-title"><div class="dbg-req-file">${escapeHtmlDebug(r.rule)} <span class="dbg-tag ${r.on ? 'service' : 'addon'}">${r.on ? 'on' : 'off'}</span></div>`
          + `<div class="dbg-req-sub">${escapeHtmlDebug(r.description)}</div>`
          + (examples ? `<details class="dbg-rejected"><summary>Examples (${r.examples.length})</summary>${examples}</details>` : '')
          + `</div><div class="dbg-req-side"><div>${r.changed} of ${r.evaluated}</div><div class="dbg-muted">first pick changes (${share}%)</div></div>`
          + `</div></div>`;
      }).join('');
  } catch (err) {
    box.innerHTML = `<div class="dbg-empty">Could not measure: ${escapeHtmlDebug(err.message || String(err))}</div>`;
  }
}

function renderDownloads() {
  const box = document.getElementById('dbg-downloads');
  const info = document.getElementById('dbg-dl-page-info');
  if (!box) return;
  const entries = debugState.dlEntries;
  const total = entries.length;
  const pages = Math.max(1, Math.ceil(total / debugState.dlPageSize));
  debugState.dlPage = Math.min(Math.max(1, debugState.dlPage), pages);
  const from = (debugState.dlPage - 1) * debugState.dlPageSize;
  const slice = entries.slice(from, from + debugState.dlPageSize);
  box.innerHTML = slice.length
    ? slice.map(f => {
      const key = `${f.at}|${f.host}|${f.release || ''}`;
      const isOpen = debugState.openDl.has(key);
      return `<div class="dbg-req${isOpen ? ' open' : ''}" data-key="${escapeHtmlDebug(key)}">`
        + `<div class="dbg-req-head"><svg class="dbg-chev" viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M8.59,16.58L13.17,12L8.59,7.41L10,6L16,12L10,18L8.59,16.58Z"/></svg>`
        + `<div class="dbg-req-title"><div class="dbg-req-file">${escapeHtmlDebug(f.release || f.host)}</div>`
        + `<div class="dbg-req-sub">${escapeHtmlDebug(f.host)} · ${escapeHtmlDebug(f.place)}</div></div>`
        + `<div class="dbg-req-side"><span class="dbg-tag ${f.recovered ? 'service' : 'addon'}">${f.recovered ? 'recovered' : 'failed'}</span>`
        + `<div class="dbg-muted">${new Date(f.at).toLocaleString('en-GB', { hour12: false })}</div></div></div>`
        + `<div class="dbg-req-body"><div class="dbg-flow">${escapeHtmlDebug(f.reason)}</div></div></div>`;
    }).join('')
    : '<div class="dbg-empty">No failed download yet.</div>';
  if (info) info.textContent = total ? `${from + 1}-${from + slice.length} of ${total} · page ${debugState.dlPage}/${pages}` : '';
  const prev = document.getElementById('dbg-dl-prev');
  const next = document.getElementById('dbg-dl-next');
  if (prev) prev.disabled = debugState.dlPage <= 1;
  if (next) next.disabled = debugState.dlPage >= pages;
}

const ACT_STEPS = [['request', 'Request'], ['search', 'Search'], ['rank', 'Rank'], ['list', 'List sent'], ['references', 'References'], ['compute', 'Compute'], ['asked', 'Player asked'], ['delivered', 'Delivered']];
const ACT_MAX_SESSIONS = 15;

/** Puts one step of the server into the card of its play (a new card at every "request") */
function applyActivityEvent(ev) {
  const list = debugState.actSessions || (debugState.actSessions = []);
  const meta = ev.meta || {};
  let s = null;
  if (ev.kind !== 'request') {
    for (let i = list.length - 1; i >= 0; i--) if (list[i].film === ev.film) { s = list[i]; break; }
  } else {
    // (with several server instances the steps of one play can arrive before its request: the card they made is the
    // same play, not another one)
    const at = Date.parse(ev.at);
    for (let i = list.length - 1; i >= 0; i--) {
      const c = list[i];
      if (c.film === ev.film && !c.steps.request && c.start >= at - 1000 && c.start - at < 60000) { s = c; s.start = Math.min(s.start, at); break; }
    }
  }
  if (!s) {
    s = { film: ev.film, start: Date.parse(ev.at), last: Date.parse(ev.at), steps: {}, chips: [], warns: [], lastText: '', verdict: '', computes: 0, delivered: 0, rendered: '' };
    list.push(s);
    while (list.length > ACT_MAX_SESSIONS) list.shift();
  }
  const at = Date.parse(ev.at);
  s.last = Math.max(s.last, at);
  if (ev.kind === 'warn') s.warns.push(ev.text);
  if (meta.src) {
    const name = meta.src.name;
    const chip = s.chips.find(c => c.name === name) || (s.chips.push({ name }), s.chips[s.chips.length - 1]);
    Object.assign(chip, { state: meta.src.state, ms: meta.src.ms, error: meta.src.error || '' });
    return;
  }
  s.lastText = ev.text;
  if (meta.sources) {
    for (const name of meta.sources) if (!s.chips.some(c => c.name === name)) s.chips.push({ name, state: 'wait' });
  }
  if (meta.waived) {
    for (const c of s.chips) if (meta.waived.includes(c.name) && c.state === 'wait') c.state = 'waived';
  }
  const step = meta.step;
  if (!step) return;
  const cur = s.steps[step];
  if (step === 'delivered') s.delivered++;
  if (step === 'compute' && meta.state === 'done') { s.computes++; if (!cur) s.verdict = meta.verdict || ''; }
  if (cur && (cur.state === 'done' || cur.state === 'warn')) return;
  s.steps[step] = { state: meta.state || 'done', ms: meta.ms, at, direct: Boolean(meta.direct) };
}

/** running / done / warn (done with a problem) / stopped (never got to the list) */
function actSessionStatus(s, now) {
  const d = s.steps.delivered;
  if (d) return d.state === 'warn' ? 'warn' : 'done';
  const list = s.steps.list;
  // (a first subtitle sent as it is never reaches this server again: nothing more is expected from it)
  if (list && (list.direct || !s.steps.references) && now - list.at > 4000) return 'done';
  if (now - s.last > 30000) return list ? 'done' : 'stopped';
  return 'running';
}

function actStepLabel(key, s) {
  const st = s.steps[key];
  if (!st && (key === 'asked' || key === 'delivered') && s.steps.list && s.steps.list.direct) return 'sent as it is';
  if (!st || st.state === 'start') return '';
  if (key === 'request') return '0 ms';
  if (key === 'rank') return `+${fmtMsDebug(st.ms || 0)}`;
  if (key === 'asked') return s.steps.list ? `+${fmtMsDebug(Math.max(0, st.at - s.steps.list.at))}` : '';
  if (key === 'delivered') return st.ms === undefined ? '' : `waited ${fmtMsDebug(st.ms)}`;
  return st.ms === undefined ? '' : fmtMsDebug(st.ms);
}

function actChipHtml(c) {
  let cls = 'wait', text = 'waiting…';
  if (c.state === 'ok' || c.state === 'late') {
    cls = c.ms >= 1000 ? 'slow' : 'ok';
    text = fmtMsDebug(c.ms) + (c.state === 'late' ? ' (late)' : '');
  } else if (c.state === 'fail') {
    cls = 'fail';
    const code = /\b([45]\d\d)\b/.exec(c.error || '');
    text = /timed out/i.test(c.error || '') ? 'timeout' : (code ? code[1] : 'failed');
  } else if (c.state === 'waived') { cls = 'waived'; text = 'not waited for'; }
  return `<span class="act-chip ${cls}" title="${escapeHtmlDebug(c.error || '')}"><i></i>${escapeHtmlDebug(c.name)} <em>${escapeHtmlDebug(text)}</em></span>`;
}

function actChipOrder(c) {
  if (c.state === 'ok' || c.state === 'late' || c.state === 'fail') return c.ms;
  return c.state === 'waived' ? 1e9 : 1e8;
}

function renderActivityCard(s, now) {
  const status = actSessionStatus(s, now);
  const running = status === 'running';
  const n = ACT_STEPS.length;
  const timeoutHit = s.chips.some(c => c.state === 'fail' && /timed out/i.test(c.error || ''));
  let leadDone = 0;
  while (leadDone < n && s.steps[ACT_STEPS[leadDone][0]] && ['done', 'warn'].includes(s.steps[ACT_STEPS[leadDone][0]].state)) leadDone++;
  let lastDone = -1;
  ACT_STEPS.forEach(([k], i) => { const st = s.steps[k]; if (st && ['done', 'warn'].includes(st.state)) lastDone = i; });
  const fill = running ? Math.max(0, (leadDone - 0.5) / (n - 1)) : Math.max(0, lastDone) / (n - 1);
  const dots = ACT_STEPS.map(([k, label], i) => {
    const st = s.steps[k];
    let cls = 'pending', mark = '';
    if (st && st.state === 'done') { cls = 'done'; mark = '✓'; }
    else if (st && st.state === 'warn') { cls = 'warn'; mark = '!'; }
    else if (running && i === leadDone) cls = 'active';
    else if (!running) cls = 'skipped';
    if (k === 'search' && cls === 'done' && timeoutHit) { cls = 'warn'; mark = '!'; }
    return `<div class="act-step ${cls}"><span class="act-dot">${mark}</span><span class="act-step-name">${label}</span><span class="act-step-time">${escapeHtmlDebug(actStepLabel(k, s))}</span></div>`;
  }).join('');
  const total = fmtMsDebug((running ? now : s.last) - s.start);
  const badge = { running: 'RUNNING', done: 'DONE', warn: 'DONE · WITH WARNINGS', stopped: 'STOPPED' }[status === 'done' && s.warns.length ? 'warn' : status];
  const cardStatus = status === 'done' && s.warns.length ? 'warn' : status;
  const verdict = !running && s.verdict ? ` · ${escapeHtmlDebug(s.verdict)}` : '';
  const chips = s.chips.slice().sort((a, b) => actChipOrder(a) - actChipOrder(b)).map(actChipHtml).join('');
  let note;
  if (running) note = `Now: <b>${escapeHtmlDebug(s.lastText)}</b>`;
  else {
    const parts = [];
    if (s.steps.list && s.steps.list.direct && !s.steps.asked) parts.push('the first subtitle is from the file\'s own release group: the player gets it directly, without the check');
    if (s.computes > 1) parts.push(`${s.computes} subtitles synced`);
    if (s.delivered > 1) parts.push(`${s.delivered} sent to the player`);
    for (const w of s.warns.slice(0, 3)) parts.push(`⚠ ${w}`);
    note = parts.map(escapeHtmlDebug).join(' · ');
  }
  const trackFill = `<div class="act-track"><div class="act-fill" style="width:${(fill * 100).toFixed(1)}%"></div></div>`;
  return `<div class="act-card ${cardStatus}" data-status="${status}">`
    + `<div class="act-head"><div class="act-film">${escapeHtmlDebug(s.film)}</div><div class="act-state"><span class="act-badge">${badge}</span><span class="act-elapsed">${total}</span><span class="act-verdict">${verdict}</span></div></div>`
    + `<div class="act-steps">${trackFill}${dots}</div>`
    + (chips ? `<div class="act-chips">${chips}</div>` : '')
    + (note ? `<div class="act-note">${note}</div>` : '')
    + `</div>`;
}

function renderActivity() {
  const box = document.getElementById('dbg-activity');
  if (!box) return;
  const list = debugState.actSessions || [];
  if (!list.length) { box.innerHTML = '<div class="dbg-empty">Nothing yet. Play something and its steps appear here.</div>'; return; }
  const now = Date.now();
  box.innerHTML = list.slice().reverse().map(s => renderActivityCard(s, now)).join('');
}

/** Once a second: the running times tick, and a card whose state changed with the clock (finished) is redrawn */
function tickActivity() {
  const box = document.getElementById('dbg-activity');
  const list = debugState.actSessions;
  if (!box || !list || !list.length || debugState.actPaused) return;
  const now = Date.now();
  const cards = box.querySelectorAll('.act-card');
  const ordered = list.slice().reverse();
  let redraw = cards.length !== ordered.length;
  ordered.forEach((s, i) => {
    const card = cards[i];
    if (!card) return;
    const status = actSessionStatus(s, now);
    if (card.dataset.status !== status) redraw = true;
    else if (status === 'running') {
      const el = card.querySelector('.act-elapsed');
      if (el) el.textContent = fmtMsDebug(now - s.start);
    }
  });
  if (redraw) renderActivity();
}

async function refreshActivity() {
  const base = debugBase();
  const box = document.getElementById('dbg-activity');
  if (!base || !box || debugState.actPaused) return;
  try {
    const res = await fetch(`${base}/activity.json?after=${debugState.actSeq}&instance=${encodeURIComponent(debugState.actInstance || '')}`);
    if (!res.ok) return;
    const data = await res.json();
    // (several server instances, as on Vercel: a step is known by instance + number, and another instance answering
    // does not clear anything)
    const instance = data.instance || '';
    debugState.actSeq = data.last;
    debugState.actInstance = instance;
    const seen = debugState.actSeen || (debugState.actSeen = new Set());
    const fresh = data.events.filter(e => !seen.has(`${instance}:${e.seq}`));
    for (const e of fresh) seen.add(`${instance}:${e.seq}`);
    while (seen.size > 6000) seen.delete(seen.values().next().value);
    fresh.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
    if (fresh.length) {
      for (const e of fresh) applyActivityEvent(e);
      renderActivity();
    }
  } catch (err) {
    // the server may be waking up; try again on the next tick
  }
}

async function refreshDownloads() {
  const base = debugBase();
  const box = document.getElementById('dbg-downloads');
  const summary = document.getElementById('dbg-dl-summary');
  if (!base || !box || !summary) return;
  try {
    const res = await fetch(`${base}/downloads.json`);
    if (!res.ok) return;
    const data = await res.json();
    // (with nothing to show the list says so; the summary stays empty instead of repeating it)
    summary.textContent = data.lastWeek.length
      ? 'Last 7 days: ' + data.lastWeek.map(h => `${h.host} ${h.failed} failed${h.recovered ? `, ${h.recovered} recovered` : ''}`).join(' · ')
      : '';
    debugState.dlEntries = data.entries || [];
    renderDownloads();
  } catch (err) {
    // ignore
  }
}

/**
 * A reference as "[lang · Source] first release + N more releases": some sites list every release a subtitle fits in
 * its name (Subtitrari-noi.ro: dozens). The whole name shows on hover, or with a tap (dbg-ref toggles .full).
 */
function referenceLabel(r) {
  const m = /^\[([^\]]*)\]\s*(.*)$/.exec(r.label || '');
  const lang = m ? m[1] : '';
  const name = m ? m[2] : (r.label || '');
  const source = r.provider ? (debugState.names[r.provider] || r.provider) : '';
  const parts = name.split(';').map(x => x.trim()).filter(Boolean);
  const head = `[${escapeHtmlDebug([lang, source].filter(Boolean).join(' · '))}] `;
  if (parts.length <= 1) return head + escapeHtmlDebug(name);
  return head + `<span class="dbg-ref-short">${escapeHtmlDebug(parts[0])} <i>+ ${parts.length - 1} more release${parts.length > 2 ? 's' : ''}</i></span>`
    + `<span class="dbg-ref-full">${escapeHtmlDebug(name)}</span>`;
}

async function refreshSubsync() {
  const base = debugBase();
  if (!base) return;
  try {
    const res = await fetch(`${base}/alignments.json`);
    if (!res.ok) return;
    debugState.subsyncEntries = (await res.json()).entries || [];
    renderSubsync();
  } catch (err) {
    // ignore
  }
}

// The decisions are shown a page at a time (own page size, remembered in this browser)
/** One line for where the time of a subtitle went (see AlignmentTiming) */
function timingOfDecision(t) {
  const asked = t.askedAfterMs > 100 ? `asked ${fmtMsDebug(t.askedAfterMs)} after the preparation began (prepared in advance)` : 'asked when the preparation began';
  return `time: subtitle ${fmtMsDebug(t.subtitleMs)} · references ${fmtMsDebug(t.referencesMs)} (both from the start, in parallel) · computation ${fmtMsDebug(t.computeMs)}`
    + ` → ready ${fmtMsDebug(t.readyAfterMs)} after the start · ${asked} · the player waited <b>${fmtMsDebug(t.waitedMs)}</b>`;
}

function renderSubsync() {
  const box = document.getElementById('dbg-subsync');
  const info = document.getElementById('dbg-subsync-page-info');
  if (!box) return;
  const entries = debugState.subsyncEntries;
  const total = entries.length;
  const pages = Math.max(1, Math.ceil(total / debugState.subsyncPageSize));
  debugState.subsyncPage = Math.min(Math.max(1, debugState.subsyncPage), pages);
  const from = (debugState.subsyncPage - 1) * debugState.subsyncPageSize;
  const slice = entries.slice(from, from + debugState.subsyncPageSize);

  if (!slice.length) {
    box.innerHTML = '<div class="dbg-empty">Nothing yet. A decision appears when you play something whose subtitles were not made by your file\'s release group.</div>';
  } else {
    box.innerHTML = slice.map(e => {
      const label = { shifted: `shifted ${e.offset > 0 ? '+' : ''}${e.offset} s${e.ratio && e.ratio !== 1 ? ` ×${e.ratio}` : ''}${e.segments > 1 ? ` · ${e.segments} parts` : ''}`, unchanged: 'unchanged', timeout: 'too slow: sent unchanged', error: 'error: sent unchanged' }[e.outcome] || e.outcome;
      const cls = e.outcome === 'shifted' ? 'service' : 'addon';
      const refs = (e.references || []).map(r => `<span class="dbg-chip dbg-ref" title="${escapeHtmlDebug(r.label)}">${referenceLabel(r)}: ${r.offset > 0 ? '+' : ''}${r.offset} s${r.ratio && r.ratio !== 1 ? ` ×${r.ratio}` : ''}${r.segments > 1 ? ` · ${r.segments} parts` : ''} (${r.score})</span>`).join('');
      return `<div class="dbg-req open"><div class="dbg-req-head" style="cursor:default">`
        + `<div class="dbg-req-title"><div class="dbg-req-file">${escapeHtmlDebug(e.subtitle || '(subtitle)')}</div>`
        + `<div class="dbg-req-sub">for ${escapeHtmlDebug(e.filename)} · ${escapeHtmlDebug(e.reason)}</div>`
        + (e.replacedBy ? `<div class="dbg-req-sub">replaced by <b>${escapeHtmlDebug(e.replacedBy)}</b></div>` : '')
        + (e.timing ? `<div class="dbg-req-sub">${timingOfDecision(e.timing)}</div>` : '')
        + `<div class="dbg-sub-meta" style="margin-top:6px">${refs}</div></div>`
        + `<div class="dbg-req-side"><span class="dbg-tag ${cls}">${escapeHtmlDebug(label)}</span><div class="dbg-muted">${new Date(e.at).toLocaleTimeString('en-GB', { timeZone: 'Europe/Bucharest', hour12: false })} · ${e.ms} ms</div></div>`
        + `</div></div>`;
    }).join('');
  }
  if (info) info.textContent = total ? `${from + 1}-${from + slice.length} of ${total} · page ${debugState.subsyncPage}/${pages}` : '';
  const prev = document.getElementById('dbg-subsync-prev');
  const next = document.getElementById('dbg-subsync-next');
  if (prev) prev.disabled = debugState.subsyncPage <= 1;
  if (next) next.disabled = debugState.subsyncPage >= pages;
}
