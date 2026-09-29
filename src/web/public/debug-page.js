// Debug page: live server log + when/what the addon was used for.
// Loaded after app.js; app.js calls startDebugPage()/stopDebugPage() when the page is shown/left.
const debugState = { logTimer: null, usageTimer: null, lastSeq: 0, paused: false, wired: false };

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
    document.getElementById('dbg-log-pause')?.addEventListener('click', event => {
      debugState.paused = !debugState.paused;
      event.currentTarget.textContent = debugState.paused ? 'Resume' : 'Pause';
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
    ? data.recent.map(e => {
      const when = new Date(e.at).toLocaleString('en-GB', { timeZone: data.tz, hour12: false });
      const file = e.filename ? escapeHtmlDebug(e.filename) : '<span class="dbg-muted">not sent</span>';
      return `<tr><td>${escapeHtmlDebug(when)}</td><td>${escapeHtmlDebug(e.type)} ${escapeHtmlDebug(e.id)}</td><td>${file}</td></tr>`;
    }).join('')
    : '<tr><td colspan="3">No requests recorded yet. Press Play on something in Stremio.</td></tr>';
}
