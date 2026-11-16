// Email filing check. Gmail logs every email Eric sends or receives as a Salesforce Task "Email: <subject>", but it
// sometimes files it on the wrong record: an email to a new prospect lands on another client's Opportunity because the
// thread mentions that client (Wildlife for All's emails kept landing on Project Coyote's Opportunity, 2026-11-16).
// Every night this finds email Tasks from the last few days whose Contact belongs to a different Account than the record
// the Task is filed on, and moves each one to the Contact's own client: its one open Opportunity if there is exactly one
// (or the one the Contact has a role on), otherwise its Account (the same rule /log-sent follows).
// Left alone: Tasks on a Lead or with no Contact, Contacts with no Account, Tasks filed on anything other than an
// Opportunity or Account, and Tasks on an Opportunity where the Contact has a contact role (they belong there on purpose).
// Reusable: nothing here knows about any one client. Salesforce access stays Task reads and Task updates (WhatId only).
// Each run is saved in ADMIN_DB (email_fix_runs) with what it moved, so Today can show it and a failure never hides.
import { salesforceToken, soql, sf, quote } from './salesforce.js';
import { clip } from './triage.js';

export const LOOKBACK_DAYS = 3;
const sfReady = env => Boolean(env.SF_DOMAIN && env.SF_CLIENT_ID && env.SF_CLIENT_SECRET);
const sfId = (prefix, id) => new RegExp('^' + prefix + '[A-Za-z0-9]{12}(?:[A-Za-z0-9]{3})?$').test(id || '');
const inList = ids => '(' + ids.map(quote).join(',') + ')';

async function ensureTable(db) {
  await db.prepare(`CREATE TABLE IF NOT EXISTS email_fix_runs (id INTEGER PRIMARY KEY AUTOINCREMENT,
    ran_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')), checked INTEGER NOT NULL DEFAULT 0,
    moved INTEGER NOT NULL DEFAULT 0, failed INTEGER NOT NULL DEFAULT 0, moves_json TEXT NOT NULL DEFAULT '[]', error TEXT NOT NULL DEFAULT '')`).run();
}

// Pure: decide where each email Task belongs. tasks carry Id, Subject, WhoId, WhatId, What.Type, What.Name, AccountId;
// contacts map Id -> { AccountId, Name, AccountName }; roles is a Set of "contactId:opportunityId"; openOpps maps
// AccountId -> [{ Id, Name }].
export function planMoves(tasks, contacts, roles, openOpps) {
  const moves = [];
  for (const t of tasks) {
    const contact = contacts.get(t.WhoId);
    const whatType = t.What?.Type;
    if (!contact?.AccountId || !t.WhatId || !['Opportunity', 'Account'].includes(whatType)) continue;
    if (t.AccountId === contact.AccountId) continue;
    if (whatType === 'Opportunity' && roles.has(t.WhoId + ':' + t.WhatId)) continue;
    const opps = openOpps.get(contact.AccountId) || [];
    const withRole = opps.filter(o => roles.has(t.WhoId + ':' + o.Id));
    const target = opps.length === 1 ? opps[0] : withRole.length === 1 ? withRole[0] : null;
    moves.push({
      taskId: t.Id, subject: clip(String(t.Subject || '').replace(/^email:\s*/i, ''), 120), contact: contact.Name || '',
      from: t.What?.Name || '', fromId: t.WhatId,
      to: target ? target.Name : contact.AccountName || '', toId: target ? target.Id : contact.AccountId
    });
  }
  return moves;
}

// The nightly run. Returns { ran, checked, moved, failed } or { ran: false, reason }.
export async function runEmailFiling(env, db) {
  if (!sfReady(env) || !env.SF_TASK_SYNC_HOST) return { ran: false, reason: 'off' };
  await ensureTable(db);
  try {
    const auth = await salesforceToken(env);
    const tasks = (await soql(auth, `SELECT Id, Subject, WhoId, WhatId, What.Type, What.Name, AccountId FROM Task
      WHERE Subject LIKE 'Email:%' AND Who.Type = 'Contact' AND WhatId != null AND CreatedDate = LAST_N_DAYS:${LOOKBACK_DAYS}
      ORDER BY CreatedDate DESC LIMIT 500`)).records;
    const whoIds = [...new Set(tasks.map(t => t.WhoId).filter(id => sfId('003', id)))];
    let moves = [];
    if (whoIds.length) {
      const contacts = new Map((await soql(auth, `SELECT Id, Name, AccountId, Account.Name FROM Contact WHERE Id IN ${inList(whoIds)}`)).records
        .map(c => [c.Id, { Name: c.Name, AccountId: c.AccountId, AccountName: c.Account?.Name || '' }]));
      const roles = new Set((await soql(auth, `SELECT ContactId, OpportunityId FROM OpportunityContactRole WHERE ContactId IN ${inList(whoIds)}`)).records
        .map(r => r.ContactId + ':' + r.OpportunityId));
      const accountIds = [...new Set([...contacts.values()].map(c => c.AccountId).filter(id => sfId('001', id)))];
      const openOpps = new Map();
      if (accountIds.length) {
        for (const o of (await soql(auth, `SELECT Id, Name, AccountId FROM Opportunity WHERE IsClosed = false AND AccountId IN ${inList(accountIds)}`)).records) {
          openOpps.set(o.AccountId, [...(openOpps.get(o.AccountId) || []), { Id: o.Id, Name: o.Name }]);
        }
      }
      moves = planMoves(tasks, contacts, roles, openOpps);
    }
    let failed = 0;
    for (const m of moves) {
      try { await sf(auth, 'PATCH', '/sobjects/Task/' + m.taskId, { WhatId: m.toId }); m.ok = true; }
      catch (error) { failed++; m.ok = false; m.error = clip(String(error.message), 160); console.error('email_fix_failed', m.taskId, error.message); }
    }
    const moved = moves.filter(m => m.ok).length;
    await db.prepare('INSERT INTO email_fix_runs (checked, moved, failed, moves_json) VALUES (?, ?, ?, ?)')
      .bind(tasks.length, moved, failed, JSON.stringify(moves)).run();
    return { ran: true, checked: tasks.length, moved, failed };
  } catch (error) {
    await db.prepare('INSERT INTO email_fix_runs (error) VALUES (?)').bind(clip(String(error.message), 300)).run();
    throw error;
  }
}

// For Today: the latest run and every move in the last 7 days. A missing table means it has never run.
export async function emailFilingOverview(db) {
  await ensureTable(db);
  const latest = await db.prepare('SELECT id, ran_at, checked, moved, failed, error FROM email_fix_runs ORDER BY id DESC LIMIT 1').first();
  if (!latest) return null;
  const { results } = await db.prepare("SELECT ran_at, moves_json FROM email_fix_runs WHERE ran_at >= strftime('%Y-%m-%dT%H:%M:%SZ','now','-7 days') AND moved + failed > 0 ORDER BY id DESC").all();
  const moves = results.flatMap(r => JSON.parse(r.moves_json || '[]').map(m => ({ ...m, at: r.ran_at })));
  return { latest, moves };
}
