const json = (data, status = 200) => Response.json(data, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });

async function readBody(request) {
  if (!request.body) throw new Error('empty');
  const reader = request.body.getReader();
  const chunks = [];
  let length = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > 24000) { await reader.cancel(); throw new Error('large'); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return JSON.parse(new TextDecoder().decode(bytes));
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    // card.positivetribes.org serves the /card folder at its root; shared fonts and brand files pass through.
    if (url.hostname === 'card.positivetribes.org' && !/^\/(fonts|brand)\//.test(url.pathname)) {
      url.pathname = '/card' + url.pathname;
      return env.ASSETS.fetch(new Request(url, request));
    }
    if (url.pathname !== '/api/contact') return env.ASSETS.fetch(request);
    if (request.method !== 'POST') return json({ error: 'Please use the contact form.' }, 405);
    if (request.headers.get('Origin') !== url.origin || !['positivetribes.org', 'www.positivetribes.org'].includes(url.hostname)) {
      return json({ error: 'Please submit from the Positive Tribes website.' }, 403);
    }
    if (!request.headers.get('Content-Type')?.startsWith('application/json')) return json({ error: 'Invalid request.' }, 415);
    try {
      const { success } = await env.CONTACT_LIMIT.limit({ key: 'contact:' + (request.headers.get('CF-Connecting-IP') || 'unknown') });
      if (!success) return json({ error: 'Please wait a minute before trying again.' }, 429);
      let data;
      try { data = await readBody(request); } catch { return json({ error: 'Please check your message and try again.' }, 400); }
      if (!data || typeof data !== 'object' || Array.isArray(data)) return json({ error: 'Invalid form data.' }, 400);
      const { name, email, message, website } = data;
      if (typeof name !== 'string' || typeof email !== 'string' || typeof message !== 'string' || website) return json({ error: 'Please check the form and try again.' }, 400);
      const cleanName = name.trim(), cleanEmail = email.trim(), cleanMessage = message.trim();
      if (!cleanName || cleanName.length > 100 || /[\r\n\x00-\x1f]/.test(cleanName) || cleanEmail.length > 254 || !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(cleanEmail) || /[\x00-\x1f\x7f]/.test(cleanEmail) || cleanMessage.length < 10 || cleanMessage.length > 5000) {
        return json({ error: 'Please enter your name, a valid email, and a message of 10–5,000 characters.' }, 400);
      }
      await env.CONTACT_MAIL.send({
        from: 'hello@positivetribes.org',
        to: env.CONTACT_TO,
        replyTo: cleanEmail,
        subject: 'Positive Tribes website message',
        text: 'New message from the Positive Tribes contact form.\n\nName: ' + cleanName + '\nEmail: ' + cleanEmail + '\n\n' + cleanMessage
      });
      return json({ ok: true });
    } catch (error) {
      console.error('contact_delivery_failed', error.code || 'unknown');
      return json({ error: 'Your message could not be sent. Please try again or email hello@positivetribes.org.' }, 503);
    }
  }
};
