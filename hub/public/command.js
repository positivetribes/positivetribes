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
  const send = (path, method, data) => api(path, { method, body: JSON.stringify(data) });
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
  const longDate = day => new Date(day + 'T12:00:00Z').toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });

  function item(i, { showClient = true, showDay = false, controls = null } = {}) {
    const url = safeUrl(i.url);
    const title = i.type === 'stale' ? `<a href="${to.client(i.accountId)}">${esc(i.title)}</a>` : url ? `<a href="${esc(url)}" target="_blank" rel="noopener">${esc(i.title)}</a>` : esc(i.title);
    const client = showClient && i.accountId && i.client ? `<a class="client-link" href="${to.client(i.accountId)}">${esc(i.client)}</a>` : '';
    const when = i.type === 'stale' ? (i.day ? 'Last contact ' + ago(i.day) : '') : [showDay ? dayName(i.day) : '', timeOf(i.at)].filter(Boolean).join(', ');
    const chip = i.reason ? `<span class="chip warn">${esc(i.reason)}</span>` : `<span class="chip${i.source === 'claude' ? ' claude' : ''}">${esc(TYPE[i.type] || i.type)}${i.source === 'claude' ? ' · suggested' : ''}</span>`;
    return `<li><div class="row"><div class="grow"><div class="title">${title}</div>
      <div class="meta">${[client, when ? esc(when) : '', i.detail ? esc(i.detail) : ''].filter(Boolean).join(' · ')}</div></div>${chip}</div>${controls ? controls(i) : ''}</li>`;
  }
  // Steps are Eric's own, so they can be completed from any list. Salesforce tasks stay read-only.
  const doneControl = i => i.type === 'step' && i.id ? `<div class="step-actions"><button type="button" data-today-done="${esc(i.id)}">Mark done</button></div>` : '';
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
      const label = left < 0 ? `${-left}${unit}${left === -1 ? '' : 's'} over` : left === 0 ? 'Due today' : `${left}${unit}${left === 1 ? '' : 's'} left`;
      return `<a class="panel countdown ${cls}" href="#/${esc(r.workspace)}/home" aria-label="${esc(r.client)}: ${esc(r.phase)} testing countdown"><span class="days">${esc(label)}</span>
        <span><strong>${esc(r.client)} · ${esc(r.project)} ${esc(r.phase)} testing and sign-off</strong><br>
        <span class="muted small">Due ${esc(longDate(r.due))} (${esc(r.days)}${business ? ' business' : ''} days from ${esc(r.started)})${r.autoAccept ? ' · accepted automatically unless problems are listed' : ''}</span></span></a>`;
    }).join('');
  }

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
    if (!list.length) return `<section class="panel nowcard"><p class="label">Now</p><h2>Nothing needs you right now</h2><p class="muted why">${skip.length || (data.now || []).some(isDone) ? 'You have skipped or finished everything for now. <button type="button" class="link" id="now-reset">Bring them back</button>' : 'No deadlines, waiting clients or revenue items. Pick something from Coming up.'}</p></section>`;
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
    box.querySelector('#now-reset')?.addEventListener('click', () => { try { localStorage.removeItem(doneKey); } catch {} save([]); });
  }

  function renderToday(box, data) {
    const attention = data.attention.slice().sort((a, b) => (a.day || '').localeCompare(b.day || ''));
    const hour = new Date().getHours();
    box.innerHTML = `${banners(data)}<div class="head"><div><p class="muted small">${esc(new Date(data.today + 'T12:00:00Z').toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' }))}</p><h2 class="greet">Good ${hour < 12 ? 'morning' : hour < 17 ? 'afternoon' : 'evening'}</h2></div></div>
    ${nowCard(data)}${countdowns(data)}
    <div class="cols">
      <section class="panel"><h2>Needs attention<span class="count">${attention.length}</span></h2>${attention.length ? `<ul class="items">${attention.map(i => item(i, { showDay: !!i.day && i.type !== 'stale', showClient: i.type !== 'stale', controls: doneControl })).join('')}</ul>` : '<p class="empty">All clear.</p>'}</section>
      <section class="panel"><h2>Coming up<span class="count">next 14 days</span></h2>${byDay(data.upcoming, { controls: doneControl })}</section>
      <section class="panel"><h2>Recent<span class="count">last 14 days</span></h2>${byDay(data.recent)}</section>
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
        <div class="meta">Last contact ${esc(ago(c.lastTouch))}${c.type ? ' · ' + esc(c.type) : ''}${c.openSteps > 1 ? ` · ${c.openSteps} open steps` : ''}</div></a>`;
    }).join('');
    box.innerHTML = `${banners(data)}<div class="head"><h2 class="greet">Clients</h2><p class="muted small">${data.clients.filter(c => c.active).length} active of ${data.clients.length}</p></div><div class="grid">${cards || '<p class="empty">No clients yet.</p>'}</div>`;
  }

  // ---- Inbox: what clients changed in their hub workspaces ----
  const dayOf = at => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Denver', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(at));
  const KIND = { question: 'question', change: 'suggestion', problem: 'problem', request: 'support request', release: 'phase' };
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
    box.innerHTML = `<div class="head"><div><h2 class="greet">Inbox</h2><p class="muted small">${data.items.length ? 'What clients changed in their workspaces. Your own edits are left out.' : 'Nothing new in the client workspaces.'}</p></div></div><div class="cols">${panels}</div>`;
    wireInbox(box);
  }

  function wireInbox(box) {
    const clear = rows => send('/inbox/clear', 'POST', { items: rows.map(i => ({ backlog: i.backlog, eventIds: i.eventIds })) });
    const reload = async () => renderInbox(box, await api('/inbox'));
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
    const stepRow = s => `<li><div class="row"><label class="check grow"><input type="checkbox" data-step-done="${s.id}"><span><span class="title">${esc(s.title)}</span>${s.dueDate ? `<span class="meta"> · ${esc(dayName(s.dueDate))}</span>` : ''}</span></label>
      ${s.source === 'claude' ? `<span class="chip claude">Suggested</span>` : ''}</div>
      <div class="small">${s.source === 'claude' ? `<button class="link" data-step-keep="${s.id}">Keep</button>` : ''}<button class="link" data-step-dismiss="${s.id}">${s.source === 'claude' ? 'Dismiss' : 'Remove'}</button></div></li>`;
    const opps = c.opportunities.map(o => `<li><div class="row"><div class="grow"><div class="title"><a href="${esc(safeUrl(o.url))}" target="_blank" rel="noopener">${esc(o.name)}</a></div><div class="meta">${o.open ? 'Target ' + esc(dayName(o.closeDate)) : o.won ? 'Won' : 'Closed'}${o.nextStep ? ' · Next: ' + esc(o.nextStep) : ''}</div></div><span class="chip">${esc(o.stage)}</span></div></li>`).join('');
    const contacts = c.contacts.map(p => `<li><div class="title"><a href="${esc(safeUrl(p.url))}" target="_blank" rel="noopener">${esc(p.name)}</a>${p.title ? ` <span class="muted small">${esc(p.title)}</span>` : ''}</div><div class="meta">${p.email ? `<a href="mailto:${esc(p.email)}">${esc(p.email)}</a>` : ''}${p.phone ? ' · ' + esc(p.phone) : ''}</div></li>`).join('');
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
        else if (t.dataset.stepDismiss) await send('/steps/' + t.dataset.stepDismiss, 'PATCH', { status: 'dismissed' });
        else if (t.dataset.noteDelete) { if (!confirm('Delete this note?')) return; await api('/notes/' + t.dataset.noteDelete, { method: 'DELETE' }); }
        overview = null; again();
      } catch (error) { alert(error.message); }
    };
  }

  // sub is what follows #/command: '', 'inbox', 'clients' or 'client/<Salesforce account id>'.
  const viewOf = sub => {
    const client = (sub || '').match(/^client\/([A-Za-z0-9]{15,18})$/);
    return client ? { view: 'client', id: client[1] } : { view: ['inbox', 'clients'].includes(sub) ? sub : 'today' };
  };
  async function show(box, sub = '', refresh = false) {
    if (current.box !== box || current.sub !== sub) scrollTo(0, 0);
    current = { box, sub };
    const { view, id } = viewOf(sub);
    box.onclick = null;
    try {
      if (!overview || refresh) await loadOverview(refresh);
      else { syncStatus(overview.lastSync); inboxBadge(overview.inboxCount); }
      if (view === 'client') {
        const data = await api('/clients/' + id);
        if (current.box !== box) return;
        document.title = data.client.name + ' | Command center';
        renderClient(box, data);
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
