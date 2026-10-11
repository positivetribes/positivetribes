import { createCheckout, stripeWebhook, donationsEnabled, salesforceToken, sf, soql, quote } from './donations.mjs';
import { handleSupport } from './support.mjs';

// Why someone filled out the contact form. Only these values are accepted; anything else counts as general.
const REASONS = { general: 'General question or idea', project: 'A nonprofit project idea', pulselift: 'PulseLift tester request', volunteer: 'Volunteering' };
// Reasons whose Leads also join a campaign (found by name, so keep these names in Salesforce).
const CAMPAIGNS = { pulselift: 'PulseLift Testers', volunteer: 'Volunteers' };
// Volunteer page help choices; must match the Volunteer_Role__c picklist on Campaign Member.
const VOLUNTEER_ROLES = ['Build (developer or designer)', 'Test or advise', 'Connect us with a nonprofit', 'Something else'];
const salesforceReady = (env) => !!(env.SF_DOMAIN && env.SF_CLIENT_ID && env.SF_CLIENT_SECRET);

// Saves the message as a Lead (Lead Source = Web). A returning person with an open Lead gets the new
// message added to that Lead instead of a duplicate. PulseLift tester requests and volunteers join their campaigns.
async function saveLead(env, { name, email, message, reason, role }) {
  const auth = await salesforceToken(env);
  const stamp = new Date().toISOString().slice(0, 10);
  const entry = '[' + stamp + '] ' + REASONS[reason] + '\n' + message;
  const found = await soql(auth, 'SELECT Id, Description FROM Lead WHERE Email = ' + quote(email) + ' AND IsConverted = false ORDER BY CreatedDate DESC LIMIT 1');
  let id;
  if (found.records.length) {
    id = found.records[0].Id;
    const description = (entry + '\n\n' + (found.records[0].Description || '')).slice(0, 32000);
    await sf(auth, 'PATCH', '/sobjects/Lead/' + id, { Description: description });
  } else {
    const parts = name.split(/\s+/);
    const lastName = parts.pop();
    const firstName = parts.join(' ').slice(0, 40) || undefined;
    id = (await sf(auth, 'POST', '/sobjects/Lead', { FirstName: firstName, LastName: lastName.slice(0, 80), Email: email, LeadSource: 'Web', Description: entry })).id;
  }
  if (CAMPAIGNS[reason]) {
    const campaign = await soql(auth, 'SELECT Id FROM Campaign WHERE Name = ' + quote(CAMPAIGNS[reason]) + ' LIMIT 1');
    if (!campaign.records.length) throw new Error('campaign_missing');
    const campaignId = campaign.records[0].Id;
    const extra = reason === 'volunteer' && role ? { Volunteer_Role__c: role } : {};
    const member = await soql(auth, 'SELECT Id FROM CampaignMember WHERE CampaignId = ' + quote(campaignId) + ' AND LeadId = ' + quote(id) + ' LIMIT 1');
    if (member.records.length) { if (extra.Volunteer_Role__c) await sf(auth, 'PATCH', '/sobjects/CampaignMember/' + member.records[0].Id, extra); }
    else await sf(auth, 'POST', '/sobjects/CampaignMember', { CampaignId: campaignId, LeadId: id, Status: 'Responded', ...extra });
  }
  return env.SF_DOMAIN.replace(/\/$/, '') + '/lightning/r/Lead/' + id + '/view';
}

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
    if (url.pathname === '/api/support') return handleSupport(request, env, url);
    if (url.pathname === '/api/donate') return createCheckout(request, env, url);
    if (url.pathname === '/api/stripe-webhook') return stripeWebhook(request, env);
    // The donate page ships with the site but stays hidden until Stripe is connected.
    if (url.pathname === '/donate.html' || url.pathname === '/donate') {
      if (!donationsEnabled(env)) return Response.redirect(url.origin + '/', 302);
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
      const reason = Object.hasOwn(REASONS, data.reason) ? data.reason : 'general';
      if (typeof name !== 'string' || typeof email !== 'string' || typeof message !== 'string' || website) return json({ error: 'Please check the form and try again.' }, 400);
      const cleanName = name.trim(), cleanEmail = email.trim(), cleanMessage = message.trim();
      if (!cleanName || cleanName.length > 100 || /[\r\n\x00-\x1f]/.test(cleanName) || cleanEmail.length > 254 || !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(cleanEmail) || /[\x00-\x1f\x7f]/.test(cleanEmail) || cleanMessage.length < 10 || cleanMessage.length > 5000) {
        return json({ error: 'Please enter your name, a valid email, and a message of 10–5,000 characters.' }, 400);
      }
      // Salesforce first, then the email. If Salesforce fails, the email still goes out and says so, so nothing is lost.
      let salesforceNote = '\n\nSalesforce is not connected, so this was not saved as a Lead.';
      if (salesforceReady(env)) {
        try { salesforceNote = '\n\nIn Salesforce: ' + await saveLead(env, { name: cleanName, email: cleanEmail, message: cleanMessage, reason, role: VOLUNTEER_ROLES.includes(data.role) ? data.role : undefined }); }
        catch (error) { console.error('contact_salesforce_failed', error.message); salesforceNote = '\n\nThis could not be saved to Salesforce (' + error.message.slice(0, 200) + '). Please add it by hand.'; }
      }
      await env.CONTACT_MAIL.send({
        from: 'hello@positivetribes.org',
        to: env.CONTACT_TO,
        replyTo: cleanEmail,
        subject: reason === 'pulselift' ? 'PulseLift tester request from the website' : reason === 'volunteer' ? 'New volunteer from the website' : 'Positive Tribes website message',
        text: 'New message from the Positive Tribes contact form.\n\nReason: ' + REASONS[reason] + '\nName: ' + cleanName + '\nEmail: ' + cleanEmail + '\n\n' + cleanMessage + salesforceNote
      });
      return json({ ok: true });
    } catch (error) {
      console.error('contact_delivery_failed', error.code || 'unknown');
      return json({ error: 'Your message could not be sent. Please try again or email hello@positivetribes.org.' }, 503);
    }
  }
};
