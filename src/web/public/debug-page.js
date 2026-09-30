// Debug page: live server log + when/what the addon was used for.
// Loaded after app.js; app.js calls startDebugPage()/stopDebugPage() when the page is shown/left.
const debugState = { logTimer: null, usageTimer: null, lastSeq: 0, paused: false, wired: false, open: new Set(), lastUsage: null, page: 1, pageSize: 5, kinds: {}, subsyncEntries: [], subsyncPage: 1, subsyncPageSize: 5 };
const PLAY_ICON = 'M8,5.14V19.14L19,12.14L8,5.14Z';
const PAUSE_ICON = 'M14,19H18V5H14M6,19H10V5H6V19Z';

function debugBase() {
  return state.uuid && isUuid(state.uuid) ? `/${state.uuid}/debug` : null;
}

// 'service' (built into subs2b) or 'addon' (imported Stremio addon) as a small tag
function kindTag(kind) {
  if (kind !== 'service' && kind !== 'addon') return '';
  return `<span class="dbg-tag ${kind}">${kind}</span>`;
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
  refreshLogs();
  debugState.logTimer = setInterval(refreshLogs, 2000);
  debugState.usageTimer = setInterval(() => { refreshUsage(); refreshProviders(); refreshSubsync(); }, 30000);
}

function stopDebugPage() {
  clearInterval(debugState.logTimer);
  clearInterval(debugState.usageTimer);
  debugState.logTimer = null;
  debugState.usageTimer = null;
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
    box.textContent += data.lines.map(l => l.text).join('\n') + '\n';
    const lines = box.textContent.split('\n');
    if (lines.length > 1500) box.textContent = lines.slice(-1000).join('\n');
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
  for (const p of data.providers || []) debugState.kinds[p.id] = p.kind;
  renderRecent();

  const body = document.getElementById('dbg-prov-body');
  const summary = document.getElementById('dbg-prov-summary');
  if (!body || !summary) return;

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
      + `<td class="dbg-prov-name">${escapeHtmlDebug(p.name)} ${kindTag(p.kind)}<div class="dbg-muted">${escapeHtmlDebug(p.id)}</div></td>`
      + `<td>${status}</td>`
      + `<td class="${rateClass}">${p.searches ? pct(p.successRate) : '-'}<div class="dbg-muted">${p.searches ? `${p.searches - p.failures}/${p.searches}` : ''}</div></td>`
      + `<td>${p.searches ? ms(p.avgMs) : '-'}<div class="dbg-muted">${p.searches ? `max ${ms(p.maxMs)}` : ''}</div></td>`
      + `<td>${p.searches ? ms(p.medianMs) : '-'}</td>`
      + `<td>${p.searches ? p.avgFound : '-'}<div class="dbg-muted">${p.searches ? `${pct(p.emptyRate)} empty` : ''}</div></td>`
      + `<td>${wins}</td><td>${inTop}</td><td>${ranked ? p.avgSent : '-'}</td>`
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
    const rows = d.top.map(t => {
      const sent = t.rank <= d.shown && !t.rejected;
      const reasons = t.reasons.map(r => `<span class="dbg-chip">${escapeHtmlDebug(r)}</span>`).join('');
      return `<div class="dbg-sub${t.rejected ? ' rejected' : ''}">`
        + `<span class="dbg-rank">#${t.rank}</span>`
        + `<div class="dbg-sub-main"><div class="dbg-sub-name">${escapeHtmlDebug(t.release) || '(no name)'}</div><div class="dbg-sub-meta"><span class="dbg-prov">${escapeHtmlDebug(t.provider)}</span>${kindTag(debugState.kinds[t.provider])}${reasons}</div></div>`
        + `<span class="dbg-score">${t.score}</span>`
        + `<span class="dbg-sent${sent ? ' yes' : ''}">${t.rejected ? 'rejected' : sent ? 'sent' : 'not sent'}</span>`
        + `</div>`;
    }).join('');
    body = `<div class="dbg-flow">${flow}</div><div class="dbg-flow dbg-muted">${mode} ${sync}</div><div class="dbg-subs">${rows || '<div class="dbg-empty">Nothing to rank.</div>'}</div>`
      + (d.top.length < d.afterScoring ? `<div class="dbg-flow dbg-muted">Only the top ${d.top.length} are listed.</div>` : '');
  }

  return `<div class="dbg-req${isOpen ? ' open' : ''}" data-key="${escapeHtmlDebug(key)}">`
    + `<div class="dbg-req-head"><svg class="dbg-chev" viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M8.59,16.58L13.17,12L8.59,7.41L10,6L16,12L10,18L8.59,16.58Z"/></svg>`
    + `<div class="dbg-req-title"><div class="dbg-req-file">${title}</div><div class="dbg-req-sub">${escapeHtmlDebug(e.type)} ${escapeHtmlDebug(e.id)}</div></div>`
    + `<div class="dbg-req-side"><div>${escapeHtmlDebug(when)}</div><div class="dbg-muted">${summary}</div></div></div>`
    + `<div class="dbg-req-body">${body}</div></div>`;
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
      const label = { shifted: `shifted ${e.offset > 0 ? '+' : ''}${e.offset} s`, unchanged: 'unchanged', timeout: 'too slow: sent unchanged', error: 'error: sent unchanged' }[e.outcome] || e.outcome;
      const cls = e.outcome === 'shifted' ? 'service' : 'addon';
      const refs = (e.references || []).map(r => `<span class="dbg-chip">${escapeHtmlDebug(r.label)}: ${r.offset > 0 ? '+' : ''}${r.offset} s (${r.score})</span>`).join('');
      return `<div class="dbg-req open"><div class="dbg-req-head" style="cursor:default">`
        + `<div class="dbg-req-title"><div class="dbg-req-file">${escapeHtmlDebug(e.subtitle || '(subtitle)')}</div>`
        + `<div class="dbg-req-sub">for ${escapeHtmlDebug(e.filename)} · ${escapeHtmlDebug(e.reason)}</div>`
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
