// Positive Tribes support hours: Monday to Friday, 8am to 6pm Mountain (kits/proposal-care-plan.md, "Support and outages").
// One clock for every support target, shared by the hub (reply times, after-outage notes) and tribe-status (outages),
// which imports this file by path. Holidays are not modelled: a target that lands on one is simply met a day early.
export const SUPPORT = {
  timeZone: 'America/Denver',
  startHour: 8,
  endHour: 18,
  // The targets, in business hours. A business day is 10 business hours.
  replyHours: 10, // problems, questions and improvement requests: reply within 1 business day
  outageHours: 4, // a tool that is down or can't be used: work starts within 4 business hours
  noteHours: 20, // after an outage: a short note in the hub within 2 business days
  soonHours: 2 // warn this many business hours before a target
};

const HOUR = 3600e3;
const fmt = new Intl.DateTimeFormat('en-US', {
  timeZone: SUPPORT.timeZone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric', weekday: 'short'
});
const DOW = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

// The Mountain wall clock at an instant.
function local(ms) {
  const p = Object.fromEntries(fmt.formatToParts(new Date(ms)).map(x => [x.type, x.value]));
  return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour % 24, min: +p.minute, s: +p.second, dow: DOW[p.weekday] };
}
// The instant of a Mountain wall-clock time (day overflow is fine: Date.UTC rolls it into the next month).
function instant(y, m, d, h) {
  const guess = Date.UTC(y, m - 1, d, h);
  const offset = ms => { const l = local(ms); return Date.UTC(l.y, l.m - 1, l.d, l.h, l.min, l.s) - ms; };
  const first = guess - offset(guess);
  return guess - offset(first);
}

export function isBusinessTime(ms) {
  const l = local(ms);
  return l.dow >= 1 && l.dow <= 5 && l.h >= SUPPORT.startHour && l.h < SUPPORT.endHour;
}

// The instant `hours` business hours after `startMs`. Time outside business hours does not count, so a problem reported
// on Friday at 5pm with a 10-hour target is due Monday at 5pm.
export function addBusinessHours(startMs, hours) {
  let t = startMs;
  let left = hours * HOUR;
  for (let guard = 0; guard < 400; guard++) {
    const l = local(t);
    if (l.dow === 0 || l.dow === 6 || l.h >= SUPPORT.endHour) { t = instant(l.y, l.m, l.d + 1, SUPPORT.startHour); continue; }
    if (l.h < SUPPORT.startHour) { t = instant(l.y, l.m, l.d, SUPPORT.startHour); continue; }
    const end = instant(l.y, l.m, l.d, SUPPORT.endHour);
    if (left <= end - t) return t + left;
    left -= end - t;
    t = end;
  }
  throw new Error('addBusinessHours did not converge');
}

// "Tue Nov 24, 3:00pm MT", for emails and the command center.
const show = new Intl.DateTimeFormat('en-US', { timeZone: SUPPORT.timeZone, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
export function formatMT(ms) {
  return show.format(new Date(ms)).replace(' AM', 'am').replace(' PM', 'pm') + ' MT';
}
// The Mountain calendar day (YYYY-MM-DD) of an instant, for Salesforce ActivityDate.
export function dayMT(ms) {
  const l = local(ms);
  return `${l.y}-${String(l.m).padStart(2, '0')}-${String(l.d).padStart(2, '0')}`;
}
// D1's CURRENT_TIMESTAMP text ("2026-11-24 17:08:46", UTC) or an ISO string, as milliseconds.
export function parseUtc(text) {
  const s = String(text || '');
  return Date.parse(/[zZ]|[+-]\d\d:\d\d$/.test(s) ? s : s.replace(' ', 'T') + 'Z');
}
