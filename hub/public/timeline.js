// The timeline chart, shared by the command center (#/command/timeline, every entry, editable) and each client
// workspace's Timeline tab (#/<client>/timeline, only the entries marked for the client, read-only).
// chart(c, today, room, options) returns HTML: c = { projects, releases (with window_end), entries }.
// Every word that comes from the hub goes through esc().
window.HubTimeline = (() => {
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const TL_MARK = ['milestone', 'deadline'];
  const TL_DONE = ['signed_off', 'live'];
  const TL_NAME = 170; // px for the row names; matches --tl-name in index.html
  const TL_STAGE = { building: 'Building', waiting: 'Built, waiting', uat: 'Testing', planned: '' };
  const tlDay = iso => new Date(iso + 'T12:00:00Z').toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });
  const tlLong = iso => new Date(iso + 'T12:00:00Z').toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
  const tlRange = e => e.end_date ? `${tlDay(e.start_date)} – ${tlDay(e.end_date)}` : tlDay(e.start_date);

  // Placed in pixels across the space the panel has (at least 640), so a short bar's label can run past its coloured
  // span without hiding the next bar: bars stack on a new line inside their row when their labels would touch.
  // waits (command center only): { entryId: { late, on: ['what it waits on', ...] } } from the client's dependencies.
  function chart(c, today, room, { editing = null, readOnly = false, flagShown = false, waits = {} } = {}) {
    const bars = c.entries.filter(e => !TL_MARK.includes(e.kind)), marks = c.entries.filter(e => TL_MARK.includes(e.kind));
    const days = c.entries.flatMap(e => [e.start_date, e.end_date || e.start_date]).concat(today).sort();
    const first = new Date(days[0].slice(0, 8) + '01T00:00:00Z'), last = new Date(days[days.length - 1] + 'T00:00:00Z');
    const t0 = first.getTime(), t1 = Date.UTC(last.getUTCFullYear(), last.getUTCMonth() + 1, 1);
    const width = Math.max(640, room), perDay = width / ((t1 - t0) / 86400e3);
    // Pixels from the left: the start of a day, or its end for the last day of a bar.
    const at = (iso, end = false) => ((Date.parse(iso + 'T00:00:00Z') - t0) / 86400e3 + (end ? 1 : 0)) * perDay;
    const px = n => n.toFixed(1) + 'px';
    const months = [];
    for (let d = first; d.getTime() < t1; d = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1))) months.push(d);
    const monthIso = d => d.toISOString().slice(0, 10);
    const head = months.map((d, i) => `<span class="tl-month" style="left:${px(at(monthIso(d)))}">${esc(d.toLocaleDateString(undefined, { month: 'short', timeZone: 'UTC' }) + (i === 0 || d.getUTCMonth() === 0 ? " '" + String(d.getUTCFullYear()).slice(2) : ''))}</span>`).join('');
    const grid = months.slice(1).map(d => `<i class="tl-grid" style="left:${px(at(monthIso(d)))}"></i>`).join('');
    const mid = iso => (at(iso) + at(iso, true)) / 2;
    const lines = marks.map(m => `<i class="tl-line m-${m.kind}" style="left:${px(mid(m.start_date))}" title="${esc(tlLong(m.start_date) + ' · ' + m.label)}"></i>`).join('')
      + `<i class="tl-line today" style="left:${px(mid(today))}"><b>Today</b></i>`;

    // Rows: the client's projects in their hub order, then named rows in the order they first start.
    const lanes = [];
    c.projects.forEach((p, i) => { const items = bars.filter(e => e.project_id === p.id); if (items.length) lanes.push({ name: p.name, tone: i % 3, items }); });
    for (const e of bars.filter(b => !b.project_id)) {
      const lane = lanes.find(l => l.lane === e.lane.toLowerCase());
      if (lane) lane.items.push(e); else lanes.push({ lane: e.lane.toLowerCase(), name: e.lane, tone: 3, items: [e] });
    }
    const shape = e => {
      const r = e.release_id ? c.releases.find(x => x.id === e.release_id) : null;
      const done = Boolean(r && TL_DONE.includes(r.stage));
      const status = !r ? '' : done ? 'Signed off' : r.stage === 'uat' && r.window_end ? 'Testing to ' + tlDay(r.window_end) : TL_STAGE[r.stage] || '';
      const title = (done ? '✓ ' : '') + e.label, sub = [tlRange(e), done ? '' : status].filter(Boolean).join(' · ');
      const left = at(e.start_date), span = Math.max(6, at(e.end_date || e.start_date, true) - left);
      // A rough width for the words (12.5px semibold, 11px dates, plus the eye), capped so one long label cannot push a row wide.
      const words = Math.min(300, Math.max(title.length * 7 + (flagShown && e.client_visible ? 17 : 0), sub.length * 6) + 18);
      return { e, done, status, title, sub, left, span, extent: Math.max(span, words) };
    };
    const pack = items => {
      const rows = [];
      for (const b of items.map(shape).sort((x, y) => x.left - y.left || x.e.id - y.e.id)) {
        const row = rows.find(r => r.end + 4 <= b.left);
        if (row) { row.items.push(b); row.end = b.left + b.extent; } else rows.push({ end: b.left + b.extent, items: [b] });
      }
      return rows;
    };
    const bar = (b, tone) => {
      const shown = flagShown && b.e.client_visible;
      const wait = !b.done && waits[b.e.id];
      const tip = [b.e.label, tlRange(b.e), b.status, b.e.kind === 'proposed' ? 'Proposed, not signed' : '', shown ? 'The client sees this' : '',
        wait ? `${wait.late ? 'Late blocker' : 'Waits on'}: ${wait.on.join(', ')}` : ''].filter(Boolean).join(' · ');
      const cls = `tl-bar t${tone} k-${b.e.kind}${b.done ? ' done' : ''}${editing === b.e.id ? ' editing' : ''}${shown ? ' shown' : ''}${wait?.late ? ' blocked' : ''}`;
      const inner = `<i class="tl-fill" style="width:${px(b.span)}"></i><span>${esc(b.title)}</span><small>${esc(b.sub)}</small>`;
      const style = `left:${px(b.left)};width:${px(b.extent)}`;
      return readOnly ? `<div class="${cls}" style="${style}" title="${esc(tip)}" role="listitem" aria-label="${esc(tip)}">${inner}</div>`
        : `<button type="button" class="${cls}" style="${style}" data-tl-edit="${b.e.id}" title="${esc(tip)}" aria-label="${esc(tip)}. Edit">${inner}</button>`;
    };
    const rows = lanes.map(l => `<div class="tl-lane"><div class="tl-name">${esc(l.name)}</div><div class="tl-track"${readOnly ? ' role="list"' : ''}>${pack(l.items).map(s => `<div class="tl-row">${s.items.map(b => bar(b, l.tone)).join('')}</div>`).join('')}</div></div>`).join('');
    const keys = [...marks].sort((a, b) => a.start_date.localeCompare(b.start_date)).map(m => {
      const words = `<i></i><strong>${esc(tlLong(m.start_date))}</strong> · ${esc(m.label)}${m.start_date < today ? ' <span class="muted">(past)</span>' : ''}${flagShown && m.client_visible ? ' <span class="muted">(client sees)</span>' : ''}`;
      return `<li class="m-${m.kind}">${readOnly ? `<span>${words}</span>` : `<button type="button" data-tl-edit="${m.id}">${words}</button>`}</li>`;
    }).join('');
    return `<div class="tl-scroll"><div class="tl" style="width:${px(width + TL_NAME)}"><div class="tl-head"><div></div><div class="tl-months">${head}</div></div>
      <div class="tl-body"><div class="tl-lines">${grid}${lines}</div>${rows || '<p class="empty small">Only dates so far.</p>'}</div></div></div>
      ${keys ? `<ul class="tl-keys">${keys}</ul>` : ''}`;
  }

  return { chart, MARK: TL_MARK, NAME: TL_NAME };
})();
