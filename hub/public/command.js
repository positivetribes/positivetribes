// The command center: Positive Tribes' home page in the hub (#/command). Today, Inbox, Clients and each client's
// page, read from /api/admin (Salesforce live, plus Eric's notes, steps and the daily synced activity).
// index.html draws the hub header and the tab row, then calls show(container, sub) on every #/command/... route.
window.CommandCenter = function createCommandCenter({ api: hubApi }) {
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const safeUrl = u => /^https?:\/\//i.test(u || '') ? u : '';
  // A link inside the hub, such as #/uep/backlog/12 (opens in this tab).
  const appUrl = u => /^#\/[a-z0-9-]+\/[a-z]+(\/\d+)?$/.test(u || '') ? u : '';
  const TYPE = { meeting: 'Meeting', calendar: 'Calendar', email: 'Email', task: 'Task', case: 'Case', step: 'Next step', note: 'Note', close: 'Close date', stage: 'Stage', lead: 'Lead', stale: 'Quiet' };
  const to = { today: '#/command', inbox: '#/command/inbox', clients: '#/command/clients', client: id => '#/command/client/' + esc(id) };
  let overview = null, inbox = null, current = { box: null, sub: '' };

  const api = (path, options = {}) => hubApi('/admin' + path, options);
  // Step changes also go to Salesforce Tasks; the hub keeps the change when Salesforce cannot be reached and retries.
  const send = async (path, method, data) => {
    const result = await api(path, { method, body: JSON.stringify(data) });
    if (result?.salesforce === 'error') alert('Saved here, but Salesforce could not be updated just now. It will catch up the next time this page loads.');
    return result;
  };
  const $ = id => document.getElementById(id);

  const dayName = day => {
    if (!day) return '';
    const today = overview?.today || new Date().toISOString().slice(0, 10);
    const diff = Math.round((Date.parse(day) - Date.parse(today)) / 86400e3);
    if (diff === 0) return 'Today';
    if (diff === 1) return 'Tomorrow';
    if (diff === -1) return 'Yesterday';
    return new Date(day + 'T12:00:00Z').toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
  };
  const timeOf = at => at && at.length > 10 ? new Date(at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', timeZone: 'America/Denver' }) : '';
  const ago = day => {
    if (!day) return 'never';
    const days = Math.round((Date.parse(overview?.today || day) - Date.parse(day)) / 86400e3);
    return days <= 0 ? 'today' : days === 1 ? 'yesterday' : days + ' days ago';
  };
  // "12 min ago", "3 h ago", "yesterday", "5 days ago" for a full timestamp.
  const seenAgo = at => {
    if (!at) return 'never';
    const mins = Math.round((Date.now() - Date.parse(at)) / 60000);
    if (mins < 15) return 'just now';
    if (mins < 60) return mins + ' min ago';
    if (mins < 24 * 60) return Math.round(mins / 60) + ' h ago';
    const days = Math.round(mins / 1440);
    return days === 1 ? 'yesterday' : days + ' days ago';
  };
  const ROLE = { ed: 'Director', staff: 'Staff' };
  // Visits are recorded from Nov 2, 2026; before that the hub did not keep them.
  const NOT_SEEN = 'No hub visit since Nov 2';
  const longDate = day => new Date(day + 'T12:00:00Z').toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });

  function item(i, { showClient = true, showDay = false, controls = null, tick = null } = {}) {
    const url = safeUrl(i.url);
    const title = i.type === 'stale' ? `<a href="${to.client(i.accountId)}">${esc(i.title)}</a>` : url ? `<a href="${esc(url)}" target="_blank" rel="noopener">${esc(i.title)}</a>` : esc(i.title);
    const client = showClient && i.accountId && i.client ? `<a class="client-link" href="${to.client(i.accountId)}">${esc(i.client)}</a>` : '';
    const when = i.type === 'stale' ? (i.day ? 'Last contact ' + ago(i.day) : '') : [showDay ? dayName(i.day) : '', timeOf(i.at)].filter(Boolean).join(', ');
    const chip = i.reason ? `<span class="chip warn">${esc(i.reason)}</span>` : `<span class="chip${i.source === 'claude' ? ' claude' : ''}">${esc(TYPE[i.type] || i.type)}${i.source === 'claude' ? ' · suggested' : ''}</span>`;
    return `<li><div class="row"><div class="grow"><div class="title">${title}</div>
      <div class="meta">${[client, when ? esc(when) : '', i.detail ? esc(i.detail) : ''].filter(Boolean).join(' · ')}</div></div>${chip}${tick ? tick(i) : ''}</div>${controls ? controls(i) : ''}</li>`;
  }
  // Steps are Eric's own, so they can be completed from any list. Salesforce tasks stay read-only.
  // A small check at the end of the row, so each step stays one compact row.
  const doneControl = i => i.type === 'step' && i.id ? `<button type="button" class="tick" data-today-done="${esc(i.id)}" title="Mark done" aria-label="Mark done: ${esc(i.title)}"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></button>` : '';
  // Long lists show the newest few, with the rest one click away.
  const RECENT_SHOWN = 10;
  function shortList(items, opts) {
    if (items.length <= RECENT_SHOWN + 2) return byDay(items, opts);
    const rest = items.slice(RECENT_SHOWN);
    return byDay(items.slice(0, RECENT_SHOWN), opts) + `<details class="more"><summary>Show ${rest.length} more</summary>${byDay(rest, opts)}</details>`;
  }
  function byDay(items, opts) {
    if (!items.length) return '<p class="empty">Nothing here.</p>';
    let html = '', last = null;
    for (const i of items) {
      if (i.day !== last) { if (last !== null) html += '</ul>'; html += `<div class="day">${esc(dayName(i.day))}</div><ul class="items">`; last = i.day; }
      html += item(i, opts);
    }
    return html + '</ul>';
  }

  function syncStatus(lastSync) {
    const el = $('cc-sync');
    if (!el) return;
    if (!lastSync) { el.textContent = 'Activity sync has not run yet'; return; }
    const hours = (Date.now() - Date.parse(lastSync.ran_at)) / 3600e3;
    el.textContent = 'Synced ' + (hours < 1 ? 'within the hour' : hours < 36 ? Math.round(hours) + ' h ago' : Math.round(hours / 24) + ' days ago');
    el.classList.toggle('late', hours > 36);
  }
  const inboxBadge = n => { const el = $('cc-inbox-count'); if (el) el.textContent = n || ''; };
  // Care plans has two parts: the plans overview and Triage (Patch's suggestions). The tab's count is suggestions waiting.
  const careBadge = n => { const el = $('cc-care-count'); if (el) el.textContent = n || ''; if (overview) overview.carePending = n; };
  const careNav = active => `<nav class="seg small subnav" aria-label="Care plans">${[['care', '#/command/care', 'Overview'], ['triage', '#/command/care/triage', 'Triage']]
    .map(([key, href, label]) => `<a href="${href}"${key === active ? ' aria-current="page"' : ''}>${label}</a>`).join('')}</nav>`;
  // The bell in the header shows the same Inbox; tell it after a clear here.
  const inboxChanged = () => window.dispatchEvent(new Event('hub-inbox-changed'));
  function banners(data) {
    let html = '';
    if (data.salesforce === 'error') html += '<div class="banner">Salesforce could not be reached, so only your notes, steps and synced activity are shown. Try Refresh in a minute.</div>';
    if (data.salesforce === 'off') html += '<div class="banner">Salesforce is not connected on this deployment, so no clients are listed.</div>';
    if (data.lastSync && Date.now() - Date.parse(data.lastSync.ran_at) > 36 * 3600e3) html += '<div class="banner">The daily activity sync has not run in over 36 hours. Check the Claude routine.</div>';
    return html;
  }

  async function loadOverview(refresh) {
    overview = await api('/overview' + (refresh ? '?refresh=1' : ''));
    syncStatus(overview.lastSync);
    inboxBadge(overview.inboxCount);
    return overview;
  }

  // Days from today to due: calendar days, or for business-day windows the weekdays still to come.
  function daysLeft(today, due, business) {
    const t = Date.parse(today + 'T00:00:00Z'), end = Date.parse(due + 'T00:00:00Z');
    const calendar = Math.round((end - t) / 864e5);
    if (!business || calendar <= 0) return calendar;
    let left = 0;
    for (let d = t + 864e5; d <= end; d += 864e5) if (new Date(d).getUTCDay() % 6 !== 0) left++;
    return left;
  }
  // Every client phase in testing, from the hub's releases: how long the client has left to test and sign off.
  function countdowns(data) {
    return (data.testing || []).map(r => {
      const business = r.dayType === 'business', left = daysLeft(data.today, r.due, business);
      const cls = left < 0 ? 'over' : left <= (business ? 3 : 7) ? 'soon' : '';
      const unit = business ? ' business day' : ' day';
      // The number large, its words small beneath, like the client's own countdown.
      const days = left === 0 ? '<span class="num">Due today</span>'
        : `<span class="num">${Math.abs(left)}</span><span class="unit">${esc(unit.trim())}${Math.abs(left) === 1 ? '' : 's'} ${left < 0 ? 'over' : 'left'}</span>`;
      return `<a class="panel countdown ${cls}" href="#/${esc(r.workspace)}/home" aria-label="${esc(r.client)}: ${esc(r.phase)} testing countdown"><span class="days">${days}</span>
        <span><strong>${esc(r.client)} · ${esc(r.project)} ${esc(r.phase)} testing and sign-off</strong><br>
        <span class="muted small">Due ${esc(longDate(r.due))} (${esc(r.days)}${business ? ' business' : ''} days from ${esc(r.started)})${r.autoAccept ? ' · accepted automatically unless problems are listed' : ''}</span></span></a>`;
    }).join('');
  }
  // Suggestions and problems waiting for our reply: one row per item, most urgent first, top 3 with "show all".
  // Each row opens that item on the client's list, where the reply box is.
  const REPLY_SHOWN = 3;
  let replyAll = false;
  const needsReplyLine = data => {
    const rows = data.needsReply || [];
    if (!rows.length) return '';
    const shown = replyAll ? rows : rows.slice(0, REPLY_SHOWN);
    const row = r => `<li class="${r.late ? 'late' : ''}"><a href="#/${esc(r.workspace)}/backlog/${esc(r.id)}"><span class="who">${esc(r.client)}</span>
      <span class="what">${esc(r.title)}</span></a>
      <span class="meta">${r.testing ? '<span class="pill testing">Test problem</span> ' : '<span class="pill">' + esc(r.kind === 'problem' ? 'Problem' : 'Change') + '</span> '}${r.days === 0 ? 'today' : esc(r.days) + (r.days === 1 ? ' business day' : ' business days')}${r.late ? ' · waiting' : ''}</span>
      <a class="btn small" href="#/${esc(r.workspace)}/backlog/${esc(r.id)}">Reply</a></li>`;
    return `<section class="panel needs-reply" aria-label="Needs a reply"><p class="label"><strong>Needs a reply</strong> <span class="muted small">${rows.length} suggested change${rows.length === 1 ? '' : 's'} and test problem${rows.length === 1 ? '' : 's'} with no answer yet</span></p>
      <ul class="reply-list">${shown.map(row).join('')}</ul>
      ${rows.length > REPLY_SHOWN ? `<button type="button" class="link" id="reply-toggle">${replyAll ? 'Show fewer' : 'Show all ' + rows.length}</button>` : ''}</section>`;
  };
  // Estimates waiting on a client's director, and approved changes still to bill and schedule.
  const estimatesLine = data => {
    const e = data.estimates || { waiting: [], toHandle: [], taskFailed: [] };
    if (!e.waiting.length && !e.toHandle.length) return '';
    const wait = r => `<li><a href="${esc(r.url)}"><span class="who">${esc(r.client)}</span> <span class="what">${esc(r.title)}</span></a>
      <span class="meta">${esc(r.hours_label)} · ${esc(r.price_label)}${r.donated ? ' donated' : ''} · ${r.days_waiting > 0 ? esc(r.days_waiting) + (r.days_waiting === 1 ? ' day' : ' days') + ' waiting' : 'sent today'}</span></li>`;
    // The client decides these, so each client folds to one line (count, hours, value, oldest); open it for the items.
    const money = c => '$' + (c / 100).toLocaleString('en-US', { maximumFractionDigits: 2 });
    const waitGroups = rows => Object.values(rows.reduce((g, r) => { (g[r.client_id] ||= []).push(r); return g; }, {}));
    const waitGroup = rows => {
      const first = rows[0], mins = rows.reduce((n, r) => n + r.minutes, 0), hrs = mins / 60;
      const cents = rows.reduce((n, r) => n + r.price_cents, 0), gift = rows.filter(r => r.donated).reduce((n, r) => n + r.price_cents, 0);
      const oldest = Math.max(...rows.map(r => r.days_waiting || 0));
      return `<details class="est-group${oldest >= 7 ? ' late' : ''}"><summary><span class="who">${esc(first.client)}</span>
        <span class="meta">${rows.length} estimate${rows.length === 1 ? '' : 's'} · ${esc(Number.isInteger(hrs) ? hrs : hrs.toFixed(1))} h · ${esc(money(cents))}${gift ? ' (' + esc(money(gift)) + ' donated)' : ''} · ${oldest > 0 ? 'oldest ' + esc(oldest) + (oldest === 1 ? ' day' : ' days') : 'sent today'}</span></summary>
        <ul class="reply-list">${rows.map(wait).join('')}</ul></details>`;
    };
    const handle = r => `<li><a href="${esc(r.url)}"><span class="who">${esc(r.client)}</span> <span class="what">${esc(r.title)}</span></a>
      <span class="meta">${r.status === 'approved_now' ? 'Add now · ' + esc(r.price_label) + (r.donated ? ' donated, schedule only' : '') : 'After launch · ' + esc(r.credits_label)}${r.sf_error ? ' · <strong>Salesforce Task failed</strong>' : ''}</span></li>`;
    return `<section class="panel needs-reply" aria-label="Estimates">
      ${e.waiting.length ? `<p class="label"><strong>Estimates waiting for the client</strong> <span class="muted small">${e.waiting.length}</span></p>${waitGroups(e.waiting).map(waitGroup).join('')}` : ''}
      ${e.toHandle.length ? `<p class="label"><strong>Approved changes to bill and schedule</strong> <span class="muted small">${e.toHandle.length}${e.taskFailed.length ? ' · ' + e.taskFailed.length + ' without a Salesforce Task' : ''}</span></p><ul class="reply-list">${e.toHandle.map(handle).join('')}</ul>` : ''}</section>`;
  };
  // Donated by Positive Tribes this year, across clients: one quiet line for funder reports.
  const donatedLine = data => {
    const d = data.donated || [];
    if (!d.length) return '';
    const minutes = d.reduce((n, r) => n + r.minutes, 0), cents = d.reduce((n, r) => n + r.value_cents, 0), hrs = minutes / 60;
    return `<p class="muted small donated-line"><strong>Donated this year:</strong> ${esc(Number.isInteger(hrs) ? hrs : hrs.toFixed(1))} hours · $${esc((cents / 100).toLocaleString('en-US', { maximumFractionDigits: 2 }))} value (${d.map(r => esc(r.client) + ' ' + esc(r.value_label)).join(', ')})</p>`;
  };
  const countdownRow = data => (data.testing || []).length ? `<div class="countdowns">${countdowns(data)}</div>` : '';

  // "Not now" only hides an item for the rest of today, in this browser.
  const skipKey = () => 'now-skipped-' + (overview?.today || '');
  const skipped = () => { try { return JSON.parse(localStorage.getItem(skipKey()) || '[]'); } catch { return []; } };
  // "Done" hides an item for 7 days (until a date), in this browser. It comes back after that if it still applies.
  const DONE_DAYS = 7, doneKey = 'now-done';
  const doneMap = () => { try { return JSON.parse(localStorage.getItem(doneKey) || '{}') || {}; } catch { return {}; } };
  const doneUntil = today => new Date(Date.parse(today + 'T12:00:00Z') + DONE_DAYS * 864e5).toISOString().slice(0, 10);
  const nowId = i => [i.type, i.id || i.title, i.accountId || ''].join('|');
  function nowCard(data) {
    const skip = skipped(), dones = doneMap(), isDone = i => (dones[nowId(i)] || '') > data.today;
    const list = (data.now || []).filter(i => !skip.includes(nowId(i)) && !isDone(i));
    // Nothing to do is one quiet line; with nothing needing attention either, it says so here instead of in its own panel.
    if (!list.length) return `<section class="panel nowcard quiet" aria-label="Now"><p class="why"><strong>Nothing needs you right now.</strong> <span class="muted">${skip.length || (data.now || []).some(isDone) ? 'You have skipped or finished everything for now. <button type="button" class="link" id="now-reset">Bring them back</button>' : (data.attention.length ? 'Nothing urgent.' : 'Nothing overdue or waiting.') + ' Pick something from Coming up.'}</span></p></section>`;
    const [top, ...rest] = list, url = top.type === 'stale' ? to.client(top.accountId) : esc(safeUrl(top.url));
    const title = url ? `<a href="${url}"${top.type === 'stale' ? '' : ' target="_blank" rel="noopener"'}>${esc(top.title)}</a>` : esc(top.title);
    const client = top.client && top.type !== 'stale' ? `<a class="client-link" href="${to.client(top.accountId)}">${esc(top.client)}</a> · ` : '';
    return `<section class="panel nowcard" aria-label="Now"><p class="label">Now</p><h2>${title}</h2>
      <p class="why">${client}<strong>${esc(top.why)}</strong>${top.detail ? ' · <span class="muted">' + esc(top.detail) + '</span>' : ''}</p>
      ${top.type === 'step' && top.id ? `<button type="button" class="primary" data-today-done="${esc(top.id)}">Mark done</button> ` : `<button type="button" class="primary" id="now-done" data-id="${esc(nowId(top))}" data-account="${top.type === 'lead' ? '' : esc(top.accountId || '')}" data-title="${esc(top.title)}">Done</button> `}<button type="button" id="now-skip" data-id="${esc(nowId(top))}">Not now</button>
      ${rest.length ? `<p class="meta later">Then: ${rest.slice(0, 3).map(i => esc(i.title)).join(' · ')}</p>` : ''}</section>`;
  }
  function wireNow(box) {
    const save = ids => { try { localStorage.setItem(skipKey(), JSON.stringify(ids)); } catch {} renderToday(box, overview); };
    box.querySelector('#now-skip')?.addEventListener('click', e => save([...skipped(), e.currentTarget.dataset.id]));
    box.querySelector('#now-done')?.addEventListener('click', async e => {
      const btn = e.currentTarget, until = doneUntil(overview.today), m = doneMap();
      m[btn.dataset.id] = until;
      try { localStorage.setItem(doneKey, JSON.stringify(m)); } catch {}
      btn.disabled = true;
      try {
        // A client item also gets a tracked follow-up step due when it comes back. Leads have no client record to hold a step.
        if (btn.dataset.account) await send('/steps', 'POST', { accountId: btn.dataset.account, title: 'Follow up: ' + btn.dataset.title, dueDate: until });
        await loadOverview(true); // re-read Salesforce so the next card is ranked on fresh data
      } catch (error) { alert(error.message); }
      renderToday(box, overview);
    });
    box.querySelector('#reply-toggle')?.addEventListener('click', () => { replyAll = !replyAll; renderToday(box, overview); });
    box.querySelector('#now-reset')?.addEventListener('click', () => { try { localStorage.removeItem(doneKey); } catch {} save([]); });
  }

  function renderToday(box, data) {
    const attention = data.attention.slice().sort((a, b) => (a.day || '').localeCompare(b.day || ''));
    const hour = new Date().getHours();
    box.innerHTML = `${banners(data)}<div class="head"><div><p class="muted small">${esc(new Date(data.today + 'T12:00:00Z').toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' }))}</p><h2 class="greet">Good ${hour < 12 ? 'morning' : hour < 17 ? 'afternoon' : 'evening'}</h2></div></div>
    ${nowCard(data)}${needsReplyLine(data)}${estimatesLine(data)}${donatedLine(data)}${countdownRow(data)}
    <div class="cols${attention.length ? '' : ' two'}">
      ${attention.length ? `<section class="panel"><h2>Needs attention<span class="count">${attention.length}</span></h2><ul class="items">${attention.map(i => item(i, { showDay: !!i.day && i.type !== 'stale' && i.type !== 'lead', showClient: i.type !== 'stale', tick: doneControl })).join('')}</ul></section>` : ''}
      <section class="panel"><h2>Coming up<span class="count">next 14 days</span></h2>${byDay(data.upcoming, { tick: doneControl })}</section>
      <section class="panel"><h2>Recent<span class="count">last 14 days</span></h2>${shortList(data.recent)}</section>
    </div>`;
    wireNow(box);
    box.onclick = async e => {
      const t = e.target.closest('[data-today-done]');
      if (!t) return;
      t.disabled = true;
      try { await send('/steps/' + t.dataset.todayDone, 'PATCH', { status: 'done' }); overview = null; again(); } catch (error) { t.disabled = false; alert(error.message); }
    };
  }

  function renderClients(box, data) {
    const cards = data.clients.map(c => {
      const stages = c.opportunities.filter(o => o.open).map(o => `<span class="chip" title="${esc(o.name)}">${esc(o.stage)}</span>`).join('') || '<span class="muted small">No open opportunities</span>';
      const oppStep = c.opportunities.find(o => o.open && o.nextStep);
      const next = c.nextStep ? `${esc(c.nextStep.title)}${c.nextStep.dueDate ? ` <span class="muted">· ${esc(dayName(c.nextStep.dueDate))}</span>` : ''}` : oppStep ? esc(oppStep.nextStep) : '<span class="muted">No next step</span>';
      return `<a class="card${c.active ? '' : ' inactive'}" href="${to.client(c.id)}"><div class="row"><h2 class="grow">${esc(c.name)}</h2>${c.workspace ? '<span class="chip">In the hub</span>' : ''}${c.pinned ? '<span class="chip">Pinned</span>' : ''}</div>
        <div class="stages">${stages}</div>
        <div class="small"><strong>Next:</strong> ${next}</div>
        <div class="meta">Last contact ${esc(ago(c.lastTouch))}${c.workspace ? (c.hubSeen ? ' · In the hub ' + esc(seenAgo(c.hubSeen)) : ' · ' + NOT_SEEN) : ''}${c.type ? ' · ' + esc(c.type) : ''}${c.openSteps > 1 ? ` · ${c.openSteps} open steps` : ''}</div></a>`;
    }).join('');
    box.innerHTML = `${banners(data)}<div class="head"><h2 class="greet">Clients</h2><p class="muted small">${data.clients.filter(c => c.active).length} active of ${data.clients.length}</p></div><div class="grid">${cards || '<p class="empty">No clients yet.</p>'}</div>`;
  }

  // ---- Inbox: what clients changed in their hub workspaces ----
  const dayOf = at => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Denver', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(at));
  const KIND = { question: 'question', change: 'suggestion', problem: 'problem', request: 'support request', release: 'phase', idea: 'hub idea' };
  function actionName(i) {
    if (i.action === 'added') return 'New ' + (KIND[i.kind] || 'item');
    if (i.action === 'done') return i.kind === 'question' ? 'Marked answered' : i.kind === 'problem' ? 'Marked fixed' : 'Marked done';
    return { answered: 'Answered', reopened: 'Reopened', tier: 'Priority changed', phase: 'Phase changed', edited: 'Edited', deleted: 'Deleted', signed_off: 'Signed off' }[i.action] || i.action;
  }
  const BACKLOG_STATUS = { off: 'The hub database is not connected.', not_ready: 'No change log yet.', error: 'Could not be read just now. Try Refresh.' };

  function inboxRow(i, n) {
    const inApp = appUrl(i.url), url = inApp || safeUrl(i.url);
    const title = url && i.action !== 'deleted' ? `<a href="${esc(url)}"${inApp ? '' : ' target="_blank" rel="noopener"'}>${esc(i.title)}</a>` : esc(i.title);
    const meta = [i.actor ? esc(i.actor) : 'Someone', esc([dayName(dayOf(i.at)), timeOf(i.at)].filter(Boolean).join(', ')), i.eventIds.length > 1 ? i.eventIds.length + ' changes' : ''].filter(Boolean).join(' · ');
    const label = actionName(i) + (i.added && i.action !== 'added' ? ' · new' : '');
    return `<li data-row="${n}"><div class="row"><div class="grow"><div class="title">${title}</div><div class="meta">${meta}</div></div><span class="chip${i.action === 'added' || i.added ? ' warn' : ''}">${esc(label)}</span></div>
      ${i.detail ? `<p class="said">${esc(i.detail)}</p>` : ''}
      <div class="small"><button class="link" data-step-for="${n}">Add next step</button><button class="link" data-clear="${n}">Clear</button></div></li>`;
  }

  function renderInbox(box, data) {
    inbox = data;
    inboxBadge(data.items.length);
    if (overview) overview.inboxCount = data.items.length;
    const panels = data.backlogs.map(b => {
      const rows = data.items.map((i, n) => [i, n]).filter(([i]) => i.backlog === b.key);
      return `<section class="panel"><div class="row"><h2 class="grow">${esc(b.name)}<span class="count">${rows.length ? rows.length + ' new' : ''}</span></h2>${rows.length > 1 ? `<button type="button" data-clear-all="${esc(b.key)}">Clear all</button>` : ''}</div>
        <p class="small links"><a class="client-link" href="${to.client(b.accountId)}">Client page</a> · <a class="client-link" href="${esc(appUrl(b.url))}">Open workspace</a></p>
        ${BACKLOG_STATUS[b.status] ? `<div class="banner">${esc(BACKLOG_STATUS[b.status])}</div>` : ''}
        ${rows.length ? `<ul class="items">${rows.map(([i, n]) => inboxRow(i, n)).join('')}</ul>` : b.status === 'ok' ? '<p class="empty">Nothing new.</p>' : ''}</section>`;
    }).join('');
    const pt = data.patch || {};
    const patchPanel = pt.pending || (pt.demotions || []).length || (pt.answered || []).length || (pt.failedRuns || []).length ? `<section class="panel"><h2>Patch</h2><ul class="items">
      ${pt.pending ? `<li><a href="#/command/care/triage">${pt.pending} suggestion${pt.pending === 1 ? '' : 's'} waiting for you</a></li>` : ''}
      ${(pt.answered || []).map(a => `<li><a href="#/${esc(a.slug)}/backlog/${a.item_id}">${esc(a.client_name)} answered a question: ${esc(a.title)}</a></li>`).join('')}
      ${(pt.demotions || []).map(c => `<li><a href="#/command/care/triage">${esc(TRUST_NAME[c.trust_kind] || c.trust_kind)} went down to level ${c.to_level}: ${esc(c.reason)}</a></li>`).join('')}
      ${(pt.failedRuns || []).map(r => `<li class="muted">Patch run ${esc(r.started_at)}: ${esc(r.note)}</li>`).join('')}</ul></section>` : '';
    box.innerHTML = `<div class="head"><div><h2 class="greet">Inbox</h2><p class="muted small">${data.items.length ? 'What clients changed in their workspaces. Your own edits are left out.' : 'Nothing new in the client workspaces.'}</p></div></div>${patchPanel}<div class="cols">${panels}</div>`;
    wireInbox(box);
  }

  function wireInbox(box) {
    const clear = rows => send('/inbox/clear', 'POST', { items: rows.map(i => ({ backlog: i.backlog, eventIds: i.eventIds })) });
    const reload = async () => { renderInbox(box, await api('/inbox')); inboxChanged(); };
    box.onclick = async e => {
      const t = e.target.closest('[data-clear],[data-clear-all],[data-step-for]');
      if (!t) return;
      try {
        if (t.dataset.clear) { await clear([inbox.items[t.dataset.clear]]); await reload(); }
        else if (t.dataset.clearAll) { await clear(inbox.items.filter(i => i.backlog === t.dataset.clearAll)); await reload(); }
        else if (t.dataset.stepFor) {
          const i = inbox.items[t.dataset.stepFor];
          const form = document.createElement('form');
          form.className = 'inline';
          form.innerHTML = `<input type="text" name="title" maxlength="300" required aria-label="Next step"><input type="date" name="dueDate" aria-label="Due date"><button class="primary">Add and clear</button><p class="err"></p>`;
          form.title.value = ('Follow up: ' + i.title).slice(0, 300);
          form.onsubmit = async ev => {
            ev.preventDefault();
            try {
              await send('/steps', 'POST', { accountId: i.accountId, title: form.title.value, dueDate: form.dueDate.value || null });
              await clear([i]); overview = null; await reload();
            } catch (error) { form.querySelector('.err').textContent = error.message; }
          };
          t.parentElement.replaceWith(form);
          form.title.focus();
        }
      } catch (error) { alert(error.message); }
    };
  }

  // ---- One client: Salesforce record, steps, notes and timeline ----
  const lines = v => v.split('\n').map(s => s.trim()).filter(Boolean);
  function renderClient(box, data) {
    const c = data.client;
    const stepRow = s => `<li><div class="row"><label class="check grow"><input type="checkbox" data-step-done="${s.id}"><span><span class="title">${esc(s.title)}</span>${s.dueDate ? `<span class="meta"> · ${esc(dayName(s.dueDate))}</span>` : ''}${s.owner ? `<span class="meta"> · ${esc(s.owner)}</span>` : ''}</span></label>
      ${s.source === 'claude' ? `<span class="chip claude">Suggested</span>` : ''}</div>
      <div class="small">${s.source === 'claude' ? `<button class="link" data-step-keep="${s.id}">Keep</button>` : ''}<button class="link" data-step-dismiss="${s.id}"${s.url ? ' data-in-salesforce="1"' : ''}>${s.source === 'claude' ? 'Dismiss' : 'Remove'}</button>${s.url ? `<a class="link" href="${esc(safeUrl(s.url))}" target="_blank" rel="noopener">Salesforce ↗</a>` : ''}</div></li>`;
    const opps = c.opportunities.map(o => `<li><div class="row"><div class="grow"><div class="title"><a href="${esc(safeUrl(o.url))}" target="_blank" rel="noopener">${esc(o.name)}</a></div><div class="meta">${o.open ? 'Target ' + esc(dayName(o.closeDate)) : o.won ? 'Won' : 'Closed'}${o.nextStep ? ' · Next: ' + esc(o.nextStep) : ''}</div></div><span class="chip">${esc(o.stage)}</span></div></li>`).join('');
    const contacts = c.contacts.map(p => `<li><div class="title"><a href="${esc(safeUrl(p.url))}" target="_blank" rel="noopener">${esc(p.name)}</a>${p.title ? ` <span class="muted small">${esc(p.title)}</span>` : ''}</div><div class="meta">${p.email ? `<a href="mailto:${esc(p.email)}">${esc(p.email)}</a>` : ''}${p.phone ? ' · ' + esc(p.phone) : ''}</div></li>`).join('');
    const hubPeople = (c.hubPeople || []).map(p => `<li><div class="row"><div class="grow"><div class="title">${esc(p.name || p.email)} <span class="muted small">${esc(ROLE[p.role] || p.role)}</span></div><div class="meta">${p.last_seen_at ? 'Last in the hub ' + esc(seenAgo(p.last_seen_at)) : NOT_SEEN}</div></div></div></li>`).join('');
    const links = c.links.map(l => `<li><a href="${esc(safeUrl(l.url))}" target="_blank" rel="noopener">${esc(l.label)}</a></li>`).join('');
    const noteControls = i => i.type === 'note' ? `<div class="small"><button class="link" data-note-delete="${i.id}">Delete</button></div>` : '';
    const timeline = (list, empty) => list.length ? byDay(list, { showClient: false, controls: noteControls }) : `<p class="empty">${empty}</p>`;
    const site = c.website ? `<a href="${esc(safeUrl(/^https?:/i.test(c.website) ? c.website : 'https://' + c.website))}" target="_blank" rel="noopener">${esc(c.website)}</a>` : '';
    box.innerHTML = `<div class="head"><div><p class="small"><a href="${to.clients}" class="client-link">← All clients</a></p><h2 class="greet">${esc(c.name)}</h2><p class="muted small">${[esc(c.type), site].filter(Boolean).join(' · ')}</p></div>
      <div class="actions">${c.workspace ? `<a class="button primary" href="#/${esc(c.workspace)}/home">Open workspace</a>` : ''}<button type="button" id="pin">${c.pinned ? 'Unpin' : 'Pin to top'}</button><a class="button" href="${esc(safeUrl(c.url))}" target="_blank" rel="noopener">Open in Salesforce ↗</a></div></div>
    <div class="detail"><aside>
      <section class="panel"><h2>Next steps<span class="count">${data.steps.length}</span></h2>${data.steps.length ? `<ul class="items">${data.steps.map(stepRow).join('')}</ul>` : '<p class="empty">No open steps.</p>'}
        <form class="inline" id="add-step"><input type="text" name="title" placeholder="Add a next step" maxlength="300" required aria-label="Next step"><input type="date" name="dueDate" aria-label="Due date"><button class="primary">Add</button></form><p class="err" id="step-err"></p></section>
      <section class="panel"><h2>Opportunities</h2>${opps ? `<ul class="items">${opps}</ul>` : '<p class="empty">None in Salesforce.</p>'}</section>
      ${c.workspace ? `<section class="panel"><h2>In the hub</h2>${hubPeople ? `<ul class="items">${hubPeople}</ul>` : '<p class="empty">No one invited yet.</p>'}</section>` : ''}
      <section class="panel"><h2>People</h2>${contacts ? `<ul class="items">${contacts}</ul>` : '<p class="empty">No contacts in Salesforce.</p>'}</section>
      <section class="panel"><h2>Links</h2>${links ? `<ul class="items">${links}</ul>` : '<p class="empty">Add the prototype, Drive folder or docs.</p>'}
        <details><summary class="small">Edit links and sync matching</summary>
        <form id="meta"><p class="small muted">Links, one per line as <em>Name | https://…</em></p><textarea name="links" aria-label="Links">${esc(c.links.map(l => l.label + ' | ' + l.url).join('\n'))}</textarea>
        <p class="small muted">Extra email domains for the daily sync (Contacts' domains are used automatically)</p><textarea name="domains" aria-label="Extra email domains">${esc((c.match.domains || []).join('\n'))}</textarea>
        <p class="small muted">Extra email addresses</p><textarea name="emails" aria-label="Extra email addresses">${esc((c.match.emails || []).join('\n'))}</textarea>
        <p class="small muted">Keywords that mean this client (e.g. project names)</p><textarea name="keywords" aria-label="Keywords">${esc((c.match.keywords || []).join('\n'))}</textarea>
        <label class="check small"><input type="checkbox" name="hidden" ${c.hidden ? 'checked' : ''}> Hide this account from the command center</label>
        <p><button class="primary">Save</button></p><p class="err" id="meta-err"></p></form></details></section>
    </aside>
    <section class="panel"><h2>Timeline</h2>
      <form id="add-note"><textarea name="body" placeholder="Add a note: what happened, what was decided…" maxlength="4000" required aria-label="Note"></textarea><p class="note-save"><button class="primary">Save note</button></p><p class="err" id="note-err"></p></form>
      <h3>Coming up</h3>${timeline(data.future, 'Nothing scheduled.')}
      <div class="now">Now</div>
      ${timeline(data.past, 'No history yet.')}
    </section></div>`;
    wireClient(box, c);
  }

  function wireClient(box, c) {
    const fail = (id, error) => { box.querySelector('#' + id).textContent = error.message; };
    box.querySelector('#add-step').onsubmit = async e => {
      e.preventDefault(); const f = e.target;
      try { await send('/steps', 'POST', { accountId: c.id, title: f.title.value, dueDate: f.dueDate.value || null }); overview = null; again(); } catch (error) { fail('step-err', error); }
    };
    box.querySelector('#add-note').onsubmit = async e => {
      e.preventDefault();
      try { await send('/notes', 'POST', { accountId: c.id, body: e.target.body.value }); again(); } catch (error) { fail('note-err', error); }
    };
    const metaPayload = (overrides = {}) => {
      const f = box.querySelector('#meta');
      const links = lines(f.links.value).map(l => { const [label, ...rest] = l.split('|'); return { label: label.trim(), url: rest.join('|').trim() }; });
      return { links, match: { domains: lines(f.domains.value), emails: lines(f.emails.value), keywords: lines(f.keywords.value) }, pinned: c.pinned, hidden: f.hidden.checked, ...overrides };
    };
    box.querySelector('#meta').onsubmit = async e => {
      e.preventDefault();
      try { await send(`/clients/${c.id}/meta`, 'PUT', metaPayload()); overview = null; again(); } catch (error) { fail('meta-err', error); }
    };
    box.querySelector('#pin').onclick = async () => {
      try { await send(`/clients/${c.id}/meta`, 'PUT', metaPayload({ pinned: !c.pinned })); overview = null; again(); } catch (error) { fail('meta-err', error); }
    };
    box.onclick = async e => {
      const t = e.target.closest('[data-step-done],[data-step-keep],[data-step-dismiss],[data-note-delete]');
      if (!t) return;
      try {
        if (t.dataset.stepDone) await send('/steps/' + t.dataset.stepDone, 'PATCH', { status: 'done' });
        else if (t.dataset.stepKeep) await send('/steps/' + t.dataset.stepKeep, 'PATCH', { keep: true });
        else if (t.dataset.stepDismiss) {
          if (t.dataset.inSalesforce && !confirm('Remove this step? Its Salesforce Task is deleted too (it stays in the Salesforce Recycle Bin for 15 days).')) return;
          await send('/steps/' + t.dataset.stepDismiss, 'PATCH', { status: 'dismissed' });
        }
        else if (t.dataset.noteDelete) { if (!confirm('Delete this note?')) return; await api('/notes/' + t.dataset.noteDelete, { method: 'DELETE' }); }
        overview = null; again();
      } catch (error) { alert(error.message); }
    };
  }

  // ---- Documents: Positive Tribes' own and every client's, as links ----
  const DOC_KIND = { plan: 'Plan', process: 'Process', proposal: 'Proposal', agreement: 'Agreement', test_script: 'Test script', design: 'Design', link: 'Link', other: 'Document' };
  const DOC_STATUS = { '': 'No status', draft: 'Draft', sent: 'Sent', signed: 'Signed' };
  let docs = null, docEditing = null;
  const options = (map, value) => Object.entries(map).map(([k, l]) => `<option value="${esc(k)}"${k === value ? ' selected' : ''}>${esc(l)}</option>`).join('');

  function docForm(data, d) {
    const forOptions = '<option value="">Positive Tribes (only you)</option>' + data.clients.map(c => `<option value="${esc(c.slug)}"${c.slug === d.client ? ' selected' : ''}>${esc(c.name)}</option>`).join('');
    return `<details class="panel docform"${d.id ? ' open' : ''}><summary>${d.id ? 'Edit document' : '+ Add a document or link'}</summary><form id="doc-form">
      <div class="fields">
        <label class="wide">Link<input type="url" name="url" value="${esc(d.url)}" maxlength="1000" placeholder="https://docs.google.com/… or https://claude.ai/artifact/…"></label>
        <label class="wide">Title<input type="text" name="title" value="${esc(d.title)}" maxlength="200" required></label>
        <label>For<select name="client">${forOptions}</select></label>
        <label>Project<select name="project_id"></select></label>
        <label>Type<select name="kind">${options(DOC_KIND, d.kind)}</select></label>
        <label>Status<select name="status">${options(DOC_STATUS, d.status)}</select></label>
        <label>Date<input type="date" name="doc_date" value="${esc(d.doc_date || '')}"></label>
        <label class="wide">Note (optional)<input type="text" name="note" value="${esc(d.note)}" maxlength="500" placeholder="Coming after the Nov 4 budget call"></label>
        <label class="check wide"><input type="checkbox" name="visible"${d.visible ? ' checked' : ''}><span>Show it in the client's workspace</span></label>
      </div>
      <p class="actions"><button class="primary">${d.id ? 'Save' : 'Add document'}</button>${d.id ? ' <button type="button" id="doc-cancel">Cancel</button>' : ''}</p><p class="err" id="doc-err"></p></form></details>`;
  }

  // Signed papers first inside a group; otherwise the saved order.
  const bySigned = (a, b) => (b.status === 'signed') - (a.status === 'signed');
  let docOpenFolders = new Set(), docOpenGroups = new Set();
  const docDate = iso => iso ? new Date(iso + 'T12:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '';

  function docRow(d, client) {
    const url = safeUrl(d.url);
    const meta = [DOC_KIND[d.kind], docDate(d.doc_date), d.note].filter(Boolean).map(esc).join(' · ');
    const seen = !d.client ? '' : d.visible ? '<span class="chip">Client sees it</span>' : '<span class="chip warn">Hidden from client</span>';
    return `<li${d.id === docEditing ? ' class="editing"' : ''}${client ? ` draggable="true" data-doc-drag="${d.id}"` : ''}><div class="row"><div class="grow"><div class="title">${url ? `<a href="${esc(url)}" target="_blank" rel="noopener">${esc(d.title)}</a>` : esc(d.title)}</div><div class="meta">${meta}</div>${d.status || seen ? `<div class="chips">${d.status ? `<span class="chip">${esc(DOC_STATUS[d.status])}</span>` : ''}${seen}</div>` : ''}</div></div>
      <div class="small"><button class="link" data-doc-edit="${d.id}">Edit</button><button class="link" data-doc-delete="${d.id}">Delete</button></div></li>`;
  }

  // A client's documents are filed under its projects. Drag a document onto another folder to move it.
  function docFolders(client, mine) {
    const folders = [...client.projects.map(p => ({ id: p.id, name: p.name })), { id: null, name: 'General' }];
    return folders.map(f => {
      const here = mine.filter(d => (d.project_id || null) === f.id).sort(bySigned);
      if (f.id === null && !here.length && client.projects.length) return '';
      const key = client.slug + ':' + (f.id || 0);
      return `<details class="folder" data-folder="${esc(key)}" data-client="${esc(client.slug)}" data-project="${f.id || ''}"${docOpenFolders.has(key) ? ' open' : ''}><summary>${esc(f.name)}<span class="count">${here.length || ''}</span></summary>
        ${here.length ? `<ul class="items">${here.map(d => docRow(d, client)).join('')}</ul>` : '<p class="empty small">Nothing here yet. Drag a document onto this folder.</p>'}</details>`;
    }).join('');
  }

  function renderDocuments(box, data) {
    docs = data;
    const editing = data.documents.find(d => d.id === docEditing);
    if (!editing) docEditing = null;
    const blank = { client: '', project_id: null, kind: 'other', title: '', url: '', note: '', status: '', visible: false, doc_date: new Date().toLocaleDateString('en-CA') };
    const groups = [{ slug: '', name: 'Positive Tribes', projects: [] }, ...data.clients].map(g => {
      const mine = data.documents.filter(d => d.client === g.slug);
      return `<section class="panel"><details class="group" data-group="${esc(g.slug)}"${docOpenGroups.has(g.slug) ? ' open' : ''}><summary><h2>${esc(g.name)}<span class="count">${mine.length || ''}</span></h2></summary>
        <p class="small muted links">${g.slug ? `Shown documents also appear in the client's workspace. <a class="client-link" href="#/${esc(g.slug)}/home">Open workspace</a>` : 'Only you see these.'}</p>
        ${!mine.length && !g.slug ? '<p class="empty">No documents yet.</p>' : g.slug ? docFolders(g, mine) : `<ul class="items">${mine.map(d => docRow(d, null)).join('')}</ul>`}</details></section>`;
    }).join('');
    box.innerHTML = `<div class="head"><div><h2 class="greet">Documents</h2><p class="muted small">Your own documents and every client's, in one place. Links open in a new tab.</p></div></div>
      ${docForm(data, editing || blank)}<div class="doc-groups">${groups}</div>`;
    wireDocuments(box, editing);
  }

  function wireDocuments(box, editing) {
    const form = box.querySelector('#doc-form');
    const projects = keep => {
      const client = docs.clients.find(c => c.slug === form.client.value);
      form.project_id.innerHTML = `<option value="">${client ? 'Whole client' : 'None'}</option>` + (client ? client.projects.map(p => `<option value="${p.id}"${p.id === keep ? ' selected' : ''}>${esc(p.name)}</option>`).join('') : '');
      form.project_id.disabled = !client;
      form.visible.disabled = !client;
      if (!client) form.visible.checked = false;
    };
    projects(editing && editing.project_id);
    form.client.onchange = () => projects(null);
    form.onsubmit = async e => {
      e.preventDefault();
      const payload = { client: form.client.value, project_id: form.project_id.value ? Number(form.project_id.value) : null, kind: form.kind.value, title: form.title.value, url: form.url.value, note: form.note.value, status: form.status.value, visible: form.visible.checked, doc_date: form.doc_date.value };
      const button = form.querySelector('button.primary');
      button.disabled = true;
      try {
        if (docEditing) await send('/documents/' + docEditing, 'PUT', payload); else await send('/documents', 'POST', payload);
        docEditing = null; again();
      } catch (error) { button.disabled = false; box.querySelector('#doc-err').textContent = error.message; }
    };
    box.querySelectorAll('details.group').forEach(el => el.addEventListener('toggle', () => { if (el.open) docOpenGroups.add(el.dataset.group); else docOpenGroups.delete(el.dataset.group); }));
    box.querySelectorAll('details.folder').forEach(el => el.addEventListener('toggle', () => { if (el.open) docOpenFolders.add(el.dataset.folder); else docOpenFolders.delete(el.dataset.folder); }));
    let dragging = null;
    box.ondragstart = e => { const li = e.target.closest('[data-doc-drag]'); if (!li) return; dragging = docs.documents.find(x => x.id === Number(li.dataset.docDrag)); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', String(dragging && dragging.id)); li.classList.add('dragging'); };
    box.ondragend = () => { dragging = null; box.querySelectorAll('.dragging,.drop').forEach(el => el.classList.remove('dragging', 'drop')); };
    box.ondragover = e => { const f = e.target.closest('details.folder'); if (!f || !dragging || f.dataset.client !== dragging.client) return; e.preventDefault(); f.classList.add('drop'); };
    box.ondragleave = e => { const f = e.target.closest('details.folder'); if (f && !f.contains(e.relatedTarget)) f.classList.remove('drop'); };
    box.ondrop = async e => {
      const f = e.target.closest('details.folder');
      if (!f || !dragging || f.dataset.client !== dragging.client) return;
      e.preventDefault(); f.classList.remove('drop');
      const project = f.dataset.project ? Number(f.dataset.project) : null;
      if ((dragging.project_id || null) === project) return;
      const d = dragging;
      try { await send('/documents/' + d.id, 'PUT', { client: d.client, project_id: project, kind: d.kind, title: d.title, url: d.url, note: d.note, status: d.status, visible: d.visible, doc_date: d.doc_date }); again(); } catch (error) { alert(error.message); }
    };
    box.querySelector('#doc-cancel')?.addEventListener('click', () => { docEditing = null; renderDocuments(box, docs); });
    box.onclick = async e => {
      const t = e.target.closest('[data-doc-edit],[data-doc-delete]');
      if (!t) return;
      if (t.dataset.docEdit) { docEditing = Number(t.dataset.docEdit); renderDocuments(box, docs); box.querySelector('.docform').scrollIntoView({ behavior: 'smooth', block: 'start' }); return; }
      const d = docs.documents.find(x => x.id === Number(t.dataset.docDelete));
      if (!d || !confirm(`Delete "${d.title}" from the hub? The document itself is not touched.`)) return;
      try { await api('/documents/' + d.id, { method: 'DELETE' }); if (docEditing === d.id) docEditing = null; again(); } catch (error) { alert(error.message); }
    };
  }

  // ---- Care plans: every client's credits, rollover, boost and checklist (screen 6) ----
  const TIER_OPTIONS = { essentials: 'Essentials ($300, 2 credits)', care: 'Care ($500, 6 credits)', growth: 'Growth ($750, 12 credits)' };
  const PLAN_STATUS = { setup: 'Setting up', active: 'Active', paused: 'Paused', ended: 'Ended' };
  const REQUEST_STATUS = { new: 'to sort', awaiting_confirm: 'waiting for the client', waiting_credits: 'waiting for credits', queued: 'in the queue', shipped: 'shipped', declined: 'declined' };
  const selectOptions = (map, chosen) => Object.entries(map).map(([k, v]) => `<option value="${esc(k)}"${k === chosen ? ' selected' : ''}>${esc(v)}</option>`).join('');

  function careRow(c) {
    const p = c.plan, b = c.balance;
    const numbers = b ? `<div class="small"><b>${b.available}</b> available · ${b.monthly} monthly · ${b.boost} boost · ${b.grantedThisMonth} granted and ${b.usedThisMonth} used this month · ${b.courtesyThisMonth} courtesy edit${b.courtesyThisMonth === 1 ? '' : 's'} · ${c.shippedThisMonth} shipped</div>` : '';
    const waiting = Object.entries(c.requests).map(([k, n]) => `${n} ${REQUEST_STATUS[k] || k}`).join(' · ');
    const flags = c.flags.map(f => `<span class="chip warn">${esc(f)}</span>`).join(' ');
    const checks = c.checklist.map(x => `<li>${x.done ? '✓' : '○'} ${esc(x.label)}</li>`).join('');
    const projects = c.projects.map(pr => `<li><div class="row"><div class="grow"><b>${esc(pr.name)}</b> <span class="meta">${esc(pr.phase)}${pr.opportunity_won ? ' · Opportunity closed-won' : pr.salesforce_opportunity_id ? ' · Opportunity not won yet' : ''}</span></div>
      <form class="row" data-opp="${pr.id}"><input type="text" name="opp" value="${esc(pr.salesforce_opportunity_id)}" maxlength="18" placeholder="Opportunity id (006…)" aria-label="Opportunity for ${esc(pr.name)}"><button>Link</button></form></div></li>`).join('');
    const contacts = '<option value="">Choose a person</option>' + c.people.map(x => `<option value="${esc(x.email)}"${p && x.email === (c.people.find(y => y.id === p.balance_contact_user_id) || {}).email ? ' selected' : ''}>${esc(x.name || x.email)}</option>`).join('');
    const form = `<form class="fields" data-plan="${c.client.id}">
      <label>Plan<select name="tier">${selectOptions(TIER_OPTIONS, p && p.tier)}</select></label>
      <label>Status<select name="status">${selectOptions(PLAN_STATUS, p ? p.status : 'setup')}</select></label>
      <label>Starts on<input type="date" name="startsOn" value="${esc(p ? p.starts_on : '')}"></label>
      <label>Rules version<input type="text" name="rulesVersion" value="${esc(p ? p.rules_version : '')}" maxlength="40" placeholder="v1"></label>
      <label class="wide">Repository<input type="url" name="repoUrl" value="${esc(p ? p.repo_url : '')}" maxlength="1000" placeholder="https://github.com/…"></label>
      <label>Test database<input type="text" name="testDb" value="${esc(p ? p.test_db : '')}" maxlength="120"></label>
      <label>Who sees balances (besides the director)<select name="balanceContactEmail">${contacts}</select></label>
      <label class="check wide"><input type="checkbox" name="testSigninsOk"${p && p.test_signins_ok ? ' checked' : ''}><span>Test sign-ins work</span></label>
      <p class="actions wide"><button class="primary">${p ? 'Save plan' : 'Create plan'}</button>${p && p.status === 'active' ? ' <button type="button" data-boost="' + c.client.id + '">Add boost pack (8 credits)</button>' : ''}</p></form>`;
    return `<section class="panel"><div class="row"><h2 class="grow">${esc(c.client.name)}</h2>${p ? `<span class="chip">${esc(p.tierName || p.tier)} · ${esc(PLAN_STATUS[p.status])}</span>` : '<span class="chip">No plan yet</span>'} <a class="client-link" href="#/${esc(c.client.slug)}/home">Open workspace</a></div>
      ${numbers}${waiting ? `<div class="small muted">Requests: ${esc(waiting)}</div>` : ''}${flags ? `<div class="small">${flags}</div>` : ''}
      <details${p && p.status === 'active' ? '' : ' open'}><summary>Setup checklist and plan</summary><ul class="small">${checks}</ul>${form}</details>
      <details><summary>Tools and Salesforce Opportunities</summary><ul class="items">${projects || '<li class="muted small">No tools yet.</li>'}</ul></details>
      <p class="err" data-err="${c.client.id}"></p></section>`;
  }

  function renderCare(box, data) {
    const active = data.clients.filter(c => c.plan && c.plan.status === 'active');
    const credits = active.reduce((n, c) => n + (c.balance ? c.balance.available : 0), 0);
    box.innerHTML = careNav('care') + `<div class="head"><div><h2 class="greet">Care plans</h2><p class="muted small">${active.length} active · ${credits} credits available across clients · $${active.reduce((n, c) => n + (c.plan.price || 0), 0)} a month${data.ai ? ` · AI cost this month ${dollars(data.ai.microUsd)}` : ''}</p></div></div>
      ${data.clients.map(careRow).join('') || '<p class="empty">No clients yet.</p>'}`;
    const fail = (id, error) => { const el = box.querySelector(`[data-err="${id}"]`); if (el) el.textContent = error.message; };
    box.onsubmit = async e => {
      e.preventDefault();
      const f = e.target;
      const id = f.dataset.plan || f.closest('section').querySelector('[data-plan]').dataset.plan;
      try {
        if (f.dataset.opp) {
          const result = await api('/projects/' + f.dataset.opp + '/opportunity', { method: 'PUT', body: JSON.stringify({ opportunityId: f.opp.value.trim() }) });
          renderCare(box, result);
        } else {
          const result = await api('/care/' + f.dataset.plan, { method: 'PUT', body: JSON.stringify({
            tier: f.tier.value, status: f.status.value, startsOn: f.startsOn.value, repoUrl: f.repoUrl.value, testDb: f.testDb.value,
            testSigninsOk: f.testSigninsOk.checked, rulesVersion: f.rulesVersion.value, balanceContactEmail: f.balanceContactEmail.value }) });
          renderCare(box, result);
        }
      } catch (error) { fail(id, error); }
    };
    box.onclick = async e => {
      const t = e.target.closest('[data-boost]');
      if (!t || !confirm('Add a boost pack of 8 credits (valid 12 months)? Record the $300 payment separately.')) return;
      try { renderCare(box, await api('/care/' + t.dataset.boost + '/boost', { method: 'POST', body: JSON.stringify({}) })); } catch (error) { fail(t.dataset.boost, error); }
    };
  }


  // ---- Triage: Patch's suggestions, trust, rules and models (screen 2) ----
  const KIND_NAME = { fix: 'Fix · free', courtesy: 'Courtesy edit', improvement: 'Improvement', project: 'New project', needs_info: 'Needs more info' };
  const TRUST_NAME = { fix: 'Fix', courtesy: 'Courtesy edit', improvement_S: 'Improvement S', improvement_M: 'Improvement M', improvement_L: 'Improvement L', needs_info: 'Needs more info' };
  const REASONS = { wrong_kind: 'Wrong kind', wrong_size: 'Wrong size', missed_rule1: 'Missed rule 1', unclear: 'Request was unclear', other: 'Other' };
  const JOB_NAME = { triage: 'Sorting requests', build: 'Building', tweak: 'Small tweaks', writing: 'Writing' };
  const dollars = micro => '$' + (micro / 1e6).toFixed(micro < 1e5 ? 3 : 2);
  const callText = d => `${KIND_NAME[d.kind]}${d.kind === 'improvement' ? ' · ' + d.size : ''}`;
  let triageData = null;
  const loadTriage = () => api('/triage');

  function decisionCard(d) {
    const blind = d.blind && d.status === 'pending';
    const flags = [d.screen_hits ? `<span class="chip warn">Rule 1 words: ${esc(d.screen_hits)}</span>` : '', d.rule1 ? '<span class="chip warn">Patch flags rule 1</span>' : '',
      d.confidence === 'low' ? '<span class="chip warn">Low confidence</span>' : ''].join(' ');
    const call = blind
      ? '<p class="small"><b>Blind check:</b> decide first. Patch\'s call shows after you do.</p>'
      : `<p><b>Patch suggests: ${esc(callText(d))}</b> <span class="chip">${esc(d.confidence)} confidence</span> ${flags}</p>
         <p class="small">${esc(d.client_reason)}${d.question ? '<br><i>Question: ' + esc(d.question) + '</i>' : ''}${d.note ? '<br><span class="muted">Note: ' + esc(d.note) + '</span>' : ''}</p>`;
    const kinds = Object.entries(KIND_NAME).map(([k, v]) => `<option value="${k}"${!blind && d.kind === k ? ' selected' : ''}>${esc(v)}</option>`).join('');
    const sizes = ['S', 'M', 'L'].map(k => `<option value="${k}"${!blind && d.size === k ? ' selected' : ''}>${k}</option>`).join('');
    const reasons = Object.entries(REASONS).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join('');
    return `<li data-decision="${d.id}"><div class="row"><div class="grow"><div class="title">${esc(d.title)}</div>
        <div class="meta">${esc(d.client_name)} · ${esc(d.project)} · rules ${esc(d.rules_version)}</div></div></div>
      ${d.details ? `<p class="small">${esc(d.details)}</p>` : ''}${call}
      <form class="row" data-decide="${d.id}">
        <select name="kind" aria-label="Kind">${kinds}</select><select name="size" aria-label="Size">${sizes}</select>
        <input type="text" name="question" maxlength="300" placeholder="Question for the client" aria-label="Question" hidden>
        <input type="text" name="note" maxlength="500" placeholder="Note for the client (optional)" aria-label="Note">
        <select name="reason" aria-label="Why you changed it"${blind ? '' : ' hidden'}><option value="">Why changed?</option>${reasons}</select>
        <button class="primary">${blind ? 'Decide' : 'Agree or change'}</button></form>
      <p class="err" data-derr="${d.id}"></p></li>`;
  }

  function trustRow(t) {
    const c = t.checks;
    const need = [!c.decisions && `${t.decisions}/30 decisions`, !c.agreement && `agreement ${t.agreement === null ? '–' : t.agreement + '%'} (needs 95% over 30)`, !c.noSeriousMiss && 'serious miss in the last 60 days', !c.clients && `${t.clients}/2 clients`].filter(Boolean).join(' · ');
    return `<li><div class="row"><div class="grow"><b>${esc(TRUST_NAME[t.kind])}</b> <span class="chip">Level ${t.level} · ${esc(t.levelName)}</span>
      <div class="meta">${t.decisions} decisions · ${t.agreement === null ? 'no agreement yet' : t.agreement + '% agreement'} · ${t.clients} client${t.clients === 1 ? '' : 's'}${t.lastSeriousMiss ? ' · last serious miss ' + esc(t.lastSeriousMiss.slice(0, 10)) : ''}${need && t.level < 1 ? ' · ' + esc(need) : ''}</div></div>
      ${t.canPromote ? `<button data-trust="${t.kind}" data-level="${t.level + 1}">Promote to Suggest</button>` : ''}${t.level > 0 ? `<button class="link" data-trust="${t.kind}" data-level="${t.level - 1}">Demote</button>` : ''}</div></li>`;
  }

  function renderTriage(box, data) {
    triageData = data;
    const last = data.runs[0];
    const failed = data.failed.length ? `<section class="panel"><h2>Sort by hand (${data.failed.length})</h2><p class="small muted">Patch could not read these. Sort them on the client page.</p>
      <ul class="items">${data.failed.map(d => `<li><div class="title">${esc(d.title)}</div><div class="meta">${esc(d.client_name)} · ${esc(d.error)}</div></li>`).join('')}</ul></section>` : '';
    const models = data.models.map(m => `<li><form class="row" data-model="${esc(m.job)}"><span class="grow"><b>${esc(JOB_NAME[m.job] || m.job)}</b> <span class="meta">${esc(m.changed_by ? 'changed by ' + m.changed_by : 'standard')}${m.previous_model ? ' · before: ' + esc(m.previous_model) : ''}${m.priced ? '' : ' · price unknown, costed high'}</span></span>
      <input type="text" name="model" value="${esc(m.model)}" maxlength="64" aria-label="Model for ${esc(m.job)}"><button>Save</button>${m.previous_model ? `<button type="button" data-rollback="${esc(m.job)}">Go back</button>` : ''}</form></li>`).join('');
    const recent = data.decided.map(d => `<li><span class="title">${esc(d.title)}</span> <span class="meta">${esc(d.client_name)} · Patch: ${esc(callText(d))} · you: ${esc(KIND_NAME[d.guide_kind])}${d.guide_size ? ' ' + d.guide_size : ''} · ${d.miss === 'none' ? 'agreed' : d.miss + ' miss'}</span></li>`).join('');
    const changes = data.trustChanges.map(c => `<li class="small">${esc(c.at.slice(0, 10))} · ${esc(TRUST_NAME[c.trust_kind] || c.trust_kind)}: level ${c.from_level} → ${c.to_level} · ${esc(c.reason)} <span class="muted">(${esc(c.actor)})</span></li>`).join('');
    const byClient = data.cost.byClient.map(c => `${esc(c.name)} ${dollars(c.cost)}`).join(' · ');
    careBadge(data.pending.length);
    box.innerHTML = careNav('triage') + `<div class="head"><div><h2 class="greet">Triage</h2>
        <p class="muted small">${data.enabled ? 'Patch checks new requests each morning.' : 'Patch is off: it needs the Anthropic API key on hub.positivetribes.org.'} AI cost this month ${dollars(data.cost.microUsd)}${byClient ? ' (' + byClient + ')' : ''}. ${last ? 'Last run ' + esc(seenAgo(last.started_at.replace(' ', 'T') + 'Z')) + ': ' + last.checked + ' checked, ' + last.failed + ' failed' + (last.note ? ', ' + esc(last.note) : '') + '.' : 'Not run yet.'}</p></div>
        <button id="run-patch"${data.enabled ? '' : ' disabled'}>Run Patch now</button></div>
      <p class="err" id="triage-err"></p>
      <section class="panel"><h2>Waiting for you${data.pending.length ? ` (${data.pending.length})` : ''}</h2>
        ${data.pending.length ? `<ul class="items">${data.pending.map(decisionCard).join('')}</ul>` : '<p class="empty">Nothing waiting.</p>'}</section>
      ${failed}
      <section class="panel"><h2>Trust, one kind of decision at a time</h2><p class="small muted">Patch only suggests for now (highest level 1). Promotion needs 30 decisions, 95% agreement over the last 30, no serious miss in 60 days and 2 clients. A serious miss, or agreement under 90%, demotes automatically. New projects and anything under rule 1 are never automated.</p>
        <ul class="items">${data.trust.map(trustRow).join('')}</ul>${changes ? `<details><summary>Level changes</summary><ul>${changes}</ul></details>` : ''}</section>
      <section class="panel"><h2>Client rules</h2><p class="small muted">Each client's own rules add to the standard five questions. Saving makes a new version.</p>
        <form class="row" id="rules-pick"><select name="client" aria-label="Client"><option value="">Choose a client</option>${(data.hubClients || []).map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select></form>
        <div id="rules-box"></div></section>
      <section class="panel"><h2>What Patch may say</h2><p class="small muted">Plain lines about this client's agreed scope, what is not included, and how to word replies. Patch uses them when drafting a reply to a suggested change or test problem, and never says yes to anything they do not cover. No prices, dates or personal details. Pick the client above. Saving makes a new version.</p>
        <div id="facts-box"><p class="small muted">Choose a client above.</p></div></section>
      <section class="panel"><h2>Models</h2><p class="small muted">Exact model ids, set here and never in code. "Go back" restores the one before.</p><ul class="items">${models}</ul></section>
      ${recent ? `<details class="panel"><summary>Recently decided</summary><ul class="items">${recent}</ul></details>` : ''}`;
    wireTriage(box);
  }

  function wireTriage(box) {
    const err = (id, e) => { const el = id ? box.querySelector(`[data-derr="${id}"]`) : $('triage-err'); if (el) el.textContent = e ? e.message : ''; };
    const reload = async () => renderTriage(box, await loadTriage());
    const syncForm = f => { f.size.hidden = f.kind.value !== 'improvement'; f.question.hidden = f.kind.value !== 'needs_info'; };
    box.querySelectorAll('[data-decide]').forEach(f => { syncForm(f); f.kind.onchange = () => syncForm(f); });
    $('run-patch').onclick = async () => {
      err(null);
      try { await api('/triage/run', { method: 'POST', body: JSON.stringify({}) }); await reload(); } catch (e) { err(null, e); }
    };
    box.onsubmit = async e => {
      e.preventDefault();
      const f = e.target;
      try {
        if (f.dataset.decide) {
          const id = f.dataset.decide, d = triageData.pending.find(x => x.id === Number(id));
          err(id);
          const kind = f.kind.value, changed = d && !d.blind && (kind !== d.kind || (kind === 'improvement' && f.size.value !== d.size));
          if (changed && !f.reason.value) { f.reason.hidden = false; return err(id, new Error('Choose why you changed it.')); }
          const result = await api(`/triage/${id}/decide`, { method: 'POST', body: JSON.stringify({
            kind, size: kind === 'improvement' ? f.size.value : undefined, question: f.question.value, note: f.note.value, change_reason: f.reason.value || undefined }) });
          // A blind check shows Patch's call now; the reason is asked for if the answers differ.
          if (result.needsReason) {
            const reason = prompt('Patch said ' + callText(result.decision) + '. Why did you choose differently?\n' + Object.entries(REASONS).map(([k, v]) => k + ' = ' + v).join('\n'), 'wrong_kind');
            if (reason && REASONS[reason]) await api(`/triage/${id}/reason`, { method: 'POST', body: JSON.stringify({ change_reason: reason }) });
          }
          if (result.demoted) alert(`${TRUST_NAME[result.demoted.kind]} went down to level ${result.demoted.to}: ${result.demoted.reason}.`);
          await reload();
        } else if (f.dataset.model) {
          await api('/models/' + f.dataset.model, { method: 'PUT', body: JSON.stringify({ model: f.model.value.trim() }) });
          await reload();
        } else if (f.id === 'rules-pick') {
          return;
        } else if (f.dataset.rules) {
          await api('/rules/' + f.dataset.rules, { method: 'PUT', body: JSON.stringify({ extra: f.extra.value }) });
          await loadRules(box, f.dataset.rules);
        } else if (f.dataset.facts) {
          await api('/facts/' + f.dataset.facts, { method: 'PUT', body: JSON.stringify({ body: f.body.value }) });
          await loadRules(box, f.dataset.facts);
        }
      } catch (error) { err(f.dataset.decide, error); }
    };
    box.onchange = e => { if (e.target.closest('#rules-pick')) loadRules(box, e.target.value); };
    box.onclick = async e => {
      const t = e.target.closest('[data-trust],[data-rollback]');
      if (!t) return;
      try {
        if (t.dataset.rollback) {
          if (!confirm('Go back to the earlier model for ' + t.dataset.rollback + '?')) return;
          await api('/models/' + t.dataset.rollback + '/rollback', { method: 'POST', body: JSON.stringify({}) });
        } else {
          const reason = prompt(Number(t.dataset.level) > triageData.trust.find(x => x.kind === t.dataset.trust).level ? 'Why promote?' : 'Why demote?');
          if (!reason) return;
          await api('/trust/' + t.dataset.trust, { method: 'PUT', body: JSON.stringify({ level: Number(t.dataset.level), reason }) });
        }
        await reload();
      } catch (error) { err(null, error); }
    };
  }

  // The rules box works by client id; the overview lists clients by Salesforce account, so find the hub id through the care list.
  async function loadRules(box, clientId) {
    const out = $('rules-box');
    if (!clientId) { out.innerHTML = ''; $('facts-box').innerHTML = '<p class="small muted">Choose a client above.</p>'; return; }
    try {
      const f = await api('/facts/' + clientId);
      $('facts-box').innerHTML = `<form data-facts="${esc(clientId)}" class="fields"><p class="small muted wide">${f.current ? 'Active: ' + esc(f.current.version) + ' · ' + f.versions.length + ' version' + (f.versions.length === 1 ? '' : 's') : 'None yet. Patch will not draft replies for this client until there are facts.'}</p>
        <label class="wide">Facts<textarea name="body" rows="14" maxlength="4000">${esc(f.current ? f.current.body : '')}</textarea></label>
        <p class="actions wide"><button class="primary">Save as a new version</button></p></form>`;
    } catch (error) { $('facts-box').innerHTML = `<p class="err">${esc(error.message)}</p>`; }
    try {
      const r = await api('/rules/' + clientId);
      const current = r.versions.find(v => v.version === r.active);
      out.innerHTML = `<form data-rules="${esc(clientId)}" class="fields"><p class="small muted wide">Active: ${esc(r.active || 'standard')}${r.versions.length ? ' · ' + r.versions.length + ' version' + (r.versions.length === 1 ? '' : 's') : ''}</p>
        <label class="wide">Extra rules<textarea name="extra" rows="6" maxlength="4000">${esc(current ? current.extra : '')}</textarea></label>
        <p class="actions wide"><button class="primary">Save as a new version</button></p></form>
        <details><summary>The standard rules</summary><pre class="small" style="white-space:pre-wrap">${esc(r.standard.text)}</pre></details>`;
    } catch (error) { out.innerHTML = `<p class="err">${esc(error.message)}</p>`; }
  }

  // sub is what follows #/command: '', 'inbox', 'clients', 'care', 'care/triage', 'documents', 'ideas' or
  // 'client/<Salesforce account id>'. The old 'triage' address still opens Triage.
  const viewOf = sub => {
    const client = (sub || '').match(/^client\/([A-Za-z0-9]{15,18})$/);
    if (client) return { view: 'client', id: client[1] };
    if (sub === 'care/triage' || sub === 'triage') return { view: 'triage' };
    return { view: ['inbox', 'clients', 'care', 'documents', 'ideas'].includes(sub) ? sub : 'today' };
  };
  async function show(box, sub = '', refresh = false) {
    if (current.box !== box || current.sub !== sub) scrollTo(0, 0);
    current = { box, sub };
    const { view, id } = viewOf(sub);
    box.onclick = null;
    try {
      if (!overview || refresh) await loadOverview(refresh);
      else { syncStatus(overview.lastSync); inboxBadge(overview.inboxCount); }
      careBadge(overview.carePending);
      if (view === 'client') {
        const data = await api('/clients/' + id);
        if (current.box !== box) return;
        document.title = data.client.name + ' | Command center';
        renderClient(box, data);
      } else if (view === 'documents') {
        const data = await api('/documents');
        if (current.box !== box) return;
        document.title = 'Documents | Command center';
        renderDocuments(box, data);
      } else if (view === 'care') {
        const data = await api('/care');
        if (current.box !== box) return;
        document.title = 'Care plans | Command center';
        renderCare(box, data);
      } else if (view === 'triage') {
        const data = await loadTriage();
        if (current.box !== box) return;
        document.title = 'Triage | Command center';
        renderTriage(box, data);
      } else if (view === 'inbox') {
        const data = await api('/inbox');
        if (current.box !== box) return;
        document.title = 'Inbox | Command center';
        renderInbox(box, data);
      } else {
        document.title = (view === 'clients' ? 'Clients' : 'Today') + ' | Command center';
        (view === 'clients' ? renderClients : renderToday)(box, overview);
      }
    } catch (error) {
      if (current.box === box) box.innerHTML = `<div class="banner">${esc(error.message)}</div>`;
    }
  }
  const again = () => current.box && show(current.box, current.sub);

  return { show, viewOf, refresh: () => current.box && show(current.box, current.sub, true) };
};
