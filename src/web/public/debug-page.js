// Debug page: live server log + when/what the addon was used for.
// Loaded after app.js; app.js calls startDebugPage()/stopDebugPage() when the page is shown/left.
const debugState = { logTimer: null, usageTimer: null, lastSeq: 0, paused: false, wired: false, open: new Set(), lastUsage: null };
const PLAY_ICON = 'M8,5.14V19.14L19,12.14L8,5.14Z';
const PAUSE_ICON = 'M14,19H18V5H14M6,19H10V5H6V19Z';

function debugBase() {
  return state.uuid && isUuid(state.uuid) ? `/${state.uuid}/debug` : null;
}

function escapeHtmlDebug(text) {
  const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
  return String(text == null ? '' : text).replace(/[&<>"]/g, c => map[c]);
}

function startDebugPage() {
  if (!debugState.wired) {
    debugState.wired = true;
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
  refreshLogs();
  debugState.logTimer = setInterval(refreshLogs, 2000);
  debugState.usageTimer = setInterval(refreshUsage, 30000);
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

  recent.innerHTML = data.recent.length
    ? data.recent.map(e => renderRequest(e, data.tz)).join('')
    : '<div class="dbg-empty">No requests recorded yet. Press Play on something in Stremio.</div>';
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
    const mode = d.usedFilename ? 'Ranked against the file name sent by the player.' : 'The player sent no file name: general-quality ranking.';
    const rows = d.top.map(t => {
      const sent = t.rank <= d.shown && !t.rejected;
      const reasons = t.reasons.map(r => `<span class="dbg-chip">${escapeHtmlDebug(r)}</span>`).join('');
      return `<div class="dbg-sub${t.rejected ? ' rejected' : ''}">`
        + `<span class="dbg-rank">#${t.rank}</span>`
        + `<div class="dbg-sub-main"><div class="dbg-sub-name">${escapeHtmlDebug(t.release) || '(no name)'}</div><div class="dbg-sub-meta"><span class="dbg-prov">${escapeHtmlDebug(t.provider)}</span>${reasons}</div></div>`
        + `<span class="dbg-score">${t.score}</span>`
        + `<span class="dbg-sent${sent ? ' yes' : ''}">${t.rejected ? 'rejected' : sent ? 'sent' : 'not sent'}</span>`
        + `</div>`;
    }).join('');
    body = `<div class="dbg-flow">${flow}</div><div class="dbg-flow dbg-muted">${mode}</div><div class="dbg-subs">${rows || '<div class="dbg-empty">Nothing to rank.</div>'}</div>`
      + (d.top.length < d.afterScoring ? `<div class="dbg-flow dbg-muted">Only the top ${d.top.length} are listed.</div>` : '');
  }

  return `<div class="dbg-req${isOpen ? ' open' : ''}" data-key="${escapeHtmlDebug(key)}">`
    + `<div class="dbg-req-head"><svg class="dbg-chev" viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M8.59,16.58L13.17,12L8.59,7.41L10,6L16,12L10,18L8.59,16.58Z"/></svg>`
    + `<div class="dbg-req-title"><div class="dbg-req-file">${title}</div><div class="dbg-req-sub">${escapeHtmlDebug(e.type)} ${escapeHtmlDebug(e.id)}</div></div>`
    + `<div class="dbg-req-side"><div>${escapeHtmlDebug(when)}</div><div class="dbg-muted">${summary}</div></div></div>`
    + `<div class="dbg-req-body">${body}</div></div>`;
}
