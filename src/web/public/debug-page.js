// Debug page: live server log + when/what the addon was used for.
// Loaded after app.js; app.js calls startDebugPage()/stopDebugPage() when the page is shown/left.
const debugState = { names: {}, logTimer: null, usageTimer: null, lastSeq: 0, paused: false, wired: false, open: new Set(), lastUsage: null, page: 1, pageSize: 5, kinds: {}, subsyncEntries: [], subsyncPage: 1, subsyncPageSize: 5 };
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
    const summary = document.getElementById('dbg-usage-summary');
    if (summary) summary.textContent = 'Save your configuration first: the debug data is tied to your addon.';
    return;
  }
  refreshUsage();
  refreshProviders();
  refreshSubsync();
  refreshDownloads();
  formatTest();
  refreshLogs();
  debugState.logTimer = setInterval(refreshLogs, 2000);
  debugState.usageTimer = setInterval(() => { refreshUsage(); refreshProviders(); refreshSubsync(); refreshDownloads(); }, 30000);
}

function stopDebugPage() {
  clearInterval(debugState.logTimer);
  clearInterval(debugState.usageTimer);
  debugState.logTimer = null;
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
    const res = await fetch(`${base}/logs.json?after=${debugState.lastSeq}`);
    if (!res.ok) return;
    const data = await res.json();
    // The server restarted: its counter went back to zero
    if (data.last < debugState.lastSeq) {
      debugState.lastSeq = 0;
      box.textContent = '';
      return;
    }
    debugState.lastSeq = data.last;
    if (!data.lines.length) return;
    const fragment = document.createDocumentFragment();
    for (const l of data.lines) fragment.appendChild(buildLogLine(l.text));
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
    return;
  }

  const pct = n => `${Math.round(n * 100)}%`;
  const ms = n => (n >= 1000 ? `${(n / 1000).toFixed(1)} s` : `${n} ms`);
  const ranked = data.withRanking || 0;
  body.innerHTML = data.providers.map(p => {
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

function renderRequest(e, tz) {
  const key = `${e.at}|${e.id}`;
  const when = new Date(e.at).toLocaleString('en-GB', { timeZone: tz, hour12: false });
  const d = e.details;
  const title = e.filename
    ? escapeHtmlDebug(e.filename)
    : `<span class="dbg-muted">File name not sent</span>`;
  const summary = d ? `${d.shown} of ${d.rawTotal} subtitles` : '';
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
    body = `<div class="dbg-flow">${flow}</div><div class="dbg-flow dbg-muted">${mode} ${sync}</div><div class="dbg-subs">${rows || '<div class="dbg-empty">Nothing to rank.</div>'}</div>`
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

async function refreshDownloads() {
  const base = debugBase();
  const box = document.getElementById('dbg-downloads');
  const summary = document.getElementById('dbg-dl-summary');
  if (!base || !box || !summary) return;
  try {
    const res = await fetch(`${base}/downloads.json`);
    if (!res.ok) return;
    const data = await res.json();
    summary.textContent = data.lastWeek.length
      ? 'Last 7 days: ' + data.lastWeek.map(h => `${h.host} ${h.failed} failed${h.recovered ? `, ${h.recovered} recovered` : ''}`).join(' · ')
      : 'No failed download in the last 7 days.';
    const shown = data.entries.slice(0, 50);
    box.innerHTML = shown.length
      ? shown.map(f => `<div class="dbg-req open"><div class="dbg-req-head" style="cursor:default">`
        + `<div class="dbg-req-title"><div class="dbg-req-file">${escapeHtmlDebug(f.release || f.host)}</div>`
        + `<div class="dbg-req-sub">${escapeHtmlDebug(f.host)} · ${escapeHtmlDebug(f.place)} · ${escapeHtmlDebug(f.reason)}</div></div>`
        + `<div class="dbg-req-side"><span class="dbg-tag ${f.recovered ? 'service' : 'addon'}">${f.recovered ? 'recovered' : 'failed'}</span>`
        + `<div class="dbg-muted">${new Date(f.at).toLocaleString('en-GB', { hour12: false })}</div></div>`
        + `</div></div>`).join('')
        + (data.entries.length > shown.length ? `<div class="dbg-flow dbg-muted">The newest ${shown.length} of ${data.entries.length} are listed.</div>` : '')
      : '<div class="dbg-empty">No failed download yet.</div>';
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
    box.innerHTML = '<div class="dbg-empty">Nothing yet. It appears when no subtitle fits your file (for example a 2160p file with only 1080p subtitles).</div>';
  } else {
    box.innerHTML = slice.map(e => {
      const label = { shifted: `shifted ${e.offset > 0 ? '+' : ''}${e.offset} s${e.ratio && e.ratio !== 1 ? ` ×${e.ratio}` : ''}${e.segments > 1 ? ` · ${e.segments} parts` : ''}`, unchanged: 'unchanged', timeout: 'too slow: sent unchanged', error: 'error: sent unchanged' }[e.outcome] || e.outcome;
      const cls = e.outcome === 'shifted' ? 'service' : 'addon';
      const refs = (e.references || []).map(r => `<span class="dbg-chip dbg-ref" title="${escapeHtmlDebug(r.label)}">${referenceLabel(r)}: ${r.offset > 0 ? '+' : ''}${r.offset} s${r.ratio && r.ratio !== 1 ? ` ×${r.ratio}` : ''}${r.segments > 1 ? ` · ${r.segments} parts` : ''} (${r.score})</span>`).join('');
      return `<div class="dbg-req open"><div class="dbg-req-head" style="cursor:default">`
        + `<div class="dbg-req-title"><div class="dbg-req-file">${escapeHtmlDebug(e.subtitle || '(subtitle)')}</div>`
        + `<div class="dbg-req-sub">for ${escapeHtmlDebug(e.filename)} · ${escapeHtmlDebug(e.reason)}</div>`
        + (e.replacedBy ? `<div class="dbg-req-sub">did not fit the references → replaced by <b>${escapeHtmlDebug(e.replacedBy)}</b></div>` : '')
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
