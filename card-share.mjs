// "Share your info" form on Eric's card (card.positivetribes.org). Emails Eric the person's details with a
// contact file attached, so saving them is one tap from the email.

const json = (data, status = 200) => Response.json(data, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
const HOSTS = ['card.positivetribes.org', 'positivetribes.org', 'www.positivetribes.org'];
const LIMITS = { name: 100, phone: 40, email: 254, company: 100, note: 1000 };

const field = (data, key) => (typeof data[key] === 'string' ? data[key].trim() : '');
// vCard text values escape backslashes, commas and semicolons, and fold newlines into \n.
const vcf = (s) => s.replace(/\\/g, '\\\\').replace(/[,;]/g, (c) => '\\' + c).replace(/\r?\n/g, '\\n');

export function contactCard({ name, phone, email, company, note }) {
  const parts = name.split(/\s+/);
  const last = parts.length > 1 ? parts.pop() : '';
  const lines = ['BEGIN:VCARD', 'VERSION:3.0', 'N:' + vcf(last) + ';' + vcf(parts.join(' ')) + ';;;', 'FN:' + vcf(name)];
  if (company) lines.push('ORG:' + vcf(company));
  if (phone) lines.push('TEL;type=CELL;type=VOICE:' + vcf(phone));
  if (email) lines.push('EMAIL;type=INTERNET:' + vcf(email));
  const met = 'Shared via card.positivetribes.org on ' + new Date().toISOString().slice(0, 10);
  lines.push('NOTE:' + vcf(note ? note + '\n\n' + met : met), 'END:VCARD', '');
  return lines.join('\r\n');
}

export async function handleCardShare(request, env, url, readBody) {
  if (request.method !== 'POST') return json({ error: 'Please use the form on the card.' }, 405);
  if (request.headers.get('Origin') !== url.origin || !HOSTS.includes(url.hostname)) return json({ error: 'Please submit from the card page.' }, 403);
  if (!request.headers.get('Content-Type')?.startsWith('application/json')) return json({ error: 'Invalid request.' }, 415);
  try {
    const { success } = await env.CONTACT_LIMIT.limit({ key: 'card:' + (request.headers.get('CF-Connecting-IP') || 'unknown') });
    if (!success) return json({ error: 'Please wait a minute before trying again.' }, 429);
    let data;
    try { data = await readBody(request); } catch { return json({ error: 'Please check the form and try again.' }, 400); }
    if (!data || typeof data !== 'object' || Array.isArray(data) || data.website) return json({ error: 'Please check the form and try again.' }, 400);
    const person = Object.fromEntries(Object.keys(LIMITS).map((key) => [key, field(data, key)]));
    for (const key of ['name', 'phone', 'email', 'company']) {
      if (person[key].length > LIMITS[key] || /[\x00-\x1f\x7f]/.test(person[key])) return json({ error: 'Please check the form and try again.' }, 400);
    }
    if (person.note.length > LIMITS.note || /[\x00-\x09\x0b-\x1f\x7f]/.test(person.note)) return json({ error: 'Please keep the note under 1,000 characters.' }, 400);
    if (!person.name) return json({ error: 'Please add your name.' }, 400);
    if (!person.phone && !person.email) return json({ error: 'Please add a phone number or email.' }, 400);
    if (person.email && !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(person.email)) return json({ error: 'Please check your email address.' }, 400);
    if (person.phone && !/^[+()\d\s.-]{7,40}$/.test(person.phone)) return json({ error: 'Please check your phone number.' }, 400);

    const rows = [['Name', person.name], ['Phone', person.phone], ['Email', person.email], ['Company', person.company]].filter(([, v]) => v);
    const text = 'Someone shared their contact info from your card.\n\n' + rows.map(([k, v]) => k + ': ' + v).join('\n') +
      (person.note ? '\n\nNote:\n' + person.note : '') + '\n\nTap the attached contact file to save them.';
    await env.CONTACT_MAIL.send({
      from: 'hello@positivetribes.org',
      to: env.CONTACT_TO,
      replyTo: person.email || undefined,
      subject: 'New contact from your card: ' + person.name,
      text,
      attachments: [{ content: new TextEncoder().encode(contactCard(person)), filename: (person.name.replace(/[^\w .-]/g, '').trim() || 'contact') + '.vcf', type: 'text/vcard', disposition: 'attachment' }]
    });
    return json({ ok: true });
  } catch (error) {
    console.error('card_share_failed', error.code || error.message || 'unknown');
    return json({ error: 'That didn’t go through. Please try again, or text Eric at (720) 762-0570.' }, 503);
  }
}
