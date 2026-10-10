// Support requests from /support.html. Each request becomes a Salesforce Case (Origin = Web), linked to the
// person's Contact and Account when their email is already in Salesforce, with an optional screenshot attached.
// An email notification always goes out, so a request is never lost if Salesforce can't be reached.
import { salesforceToken, sf, soql, quote } from './donations.mjs';

const json = (data, status = 200) => Response.json(data, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });

export const TOOLS = { pulselift: 'PulseLift', 'volunteer-connect': 'Volunteer Connect', 'partner-tool': 'A tool built for my organization', other: 'Something else' };
const KINDS = { broken: ['Something’s broken', 'Problem'], howto: ['How do I…?', 'Question'], idea: ['Feature idea', 'Feature Request'], access: ['Account or access', 'Question'] };
const IMPACTS = { minor: ['Minor annoyance', 'Low'], slowing: ['Slowing us down', 'Medium'], blocked: ['We can’t work', 'High'] };
const MAX_FILE = 5 * 1024 * 1024;

const text = (form, key) => { const v = form.get(key); return typeof v === 'string' ? v.trim() : ''; };
const oneLine = (s) => !/[\x00-\x1f\x7f]/.test(s);

// Accept only real PNG or JPEG images, checked by their first bytes rather than the name the browser sends.
async function readScreenshot(file) {
  if (!file || typeof file === 'string' || file.size === 0) return null;
  if (file.size > MAX_FILE) throw new Error('size');
  const bytes = new Uint8Array(await file.arrayBuffer());
  const png = bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
  const jpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (!png && !jpeg) throw new Error('type');
  return { bytes, ext: png ? 'png' : 'jpg' };
}

function base64(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(out);
}

async function createCase(env, req, shot) {
  const auth = await salesforceToken(env);
  const found = await soql(auth, 'SELECT Id, AccountId FROM Contact WHERE Email = ' + quote(req.email) + ' ORDER BY LastModifiedDate DESC LIMIT 1');
  const contact = found.records[0];
  const { id } = await sf(auth, 'POST', '/sobjects/Case', {
    Subject: ('[' + TOOLS[req.tool] + '] ' + req.summary).slice(0, 255),
    Description: req.description,
    Origin: 'Web', Status: 'New', Type: KINDS[req.kind][1], Priority: IMPACTS[req.impact][1],
    SuppliedName: req.name.slice(0, 80), SuppliedEmail: req.email.slice(0, 80), SuppliedCompany: req.org ? req.org.slice(0, 80) : undefined,
    ContactId: contact?.Id, AccountId: contact?.AccountId || undefined
  });
  const { CaseNumber } = await sf(auth, 'GET', '/sobjects/Case/' + id + '?fields=CaseNumber');
  let attachNote = '';
  if (shot) {
    try {
      await sf(auth, 'POST', '/sobjects/ContentVersion', { Title: 'Screenshot from ' + req.name, PathOnClient: 'screenshot.' + shot.ext, VersionData: base64(shot.bytes), FirstPublishLocationId: id });
    } catch (error) {
      console.error('support_attach_failed', error.message);
      attachNote = '\nThe screenshot could not be attached (' + error.message.slice(0, 150) + '). Ask them to send it by email.';
    }
  }
  return { caseNumber: CaseNumber, link: env.SF_DOMAIN.replace(/\/$/, '') + '/lightning/r/Case/' + id + '/view', matched: !!contact, attachNote };
}

export async function handleSupport(request, env, url) {
  if (request.method !== 'POST') return json({ error: 'Please use the support form.' }, 405);
  if (request.headers.get('Origin') !== url.origin || !['positivetribes.org', 'www.positivetribes.org'].includes(url.hostname)) {
    return json({ error: 'Please submit from the Positive Tribes website.' }, 403);
  }
  if (!request.headers.get('Content-Type')?.startsWith('multipart/form-data')) return json({ error: 'Invalid request.' }, 415);
  if (Number(request.headers.get('Content-Length') || 0) > MAX_FILE + 200000) return json({ error: 'That screenshot is too large. Please use one under 5 MB.' }, 413);
  try {
    const { success } = await env.SUPPORT_LIMIT.limit({ key: 'support:' + (request.headers.get('CF-Connecting-IP') || 'unknown') });
    if (!success) return json({ error: 'Please wait a minute before sending another request.' }, 429);
    let form;
    try { form = await request.formData(); } catch { return json({ error: 'Please check the form and try again.' }, 400); }
    if (text(form, 'website')) return json({ error: 'Please check the form and try again.' }, 400);
    const req = {
      name: text(form, 'name'), email: text(form, 'email'), org: text(form, 'org'),
      tool: text(form, 'tool'), kind: text(form, 'kind'), impact: text(form, 'impact'),
      summary: text(form, 'summary'), description: text(form, 'description')
    };
    if (!req.name || req.name.length > 100 || !oneLine(req.name) || req.org.length > 100 || !oneLine(req.org)
      || req.email.length > 254 || !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(req.email) || !oneLine(req.email)
      || !Object.hasOwn(TOOLS, req.tool) || !Object.hasOwn(KINDS, req.kind) || !Object.hasOwn(IMPACTS, req.impact)
      || req.summary.length < 5 || req.summary.length > 120 || !oneLine(req.summary)
      || req.description.length < 10 || req.description.length > 5000) {
      return json({ error: 'Please fill in every field. The summary needs 5 to 120 characters and the details 10 to 5,000.' }, 400);
    }
    let shot;
    try { shot = await readScreenshot(form.get('screenshot')); }
    catch (error) { return json({ error: error.message === 'size' ? 'That screenshot is too large. Please use one under 5 MB.' : 'Screenshots need to be PNG or JPG images.' }, 400); }

    const summary = 'Tool: ' + TOOLS[req.tool] + '\nRequest: ' + KINDS[req.kind][0] + '\nImpact: ' + IMPACTS[req.impact][0]
      + '\nName: ' + req.name + '\nEmail: ' + req.email + (req.org ? '\nOrganization: ' + req.org : '')
      + '\n\nSummary: ' + req.summary + '\n\n' + req.description;
    let result = null, note;
    if (env.SF_DOMAIN && env.SF_CLIENT_ID && env.SF_CLIENT_SECRET) {
      try {
        result = await createCase(env, req, shot);
        note = '\n\nIn Salesforce: ' + result.link + (result.matched ? '' : '\n(No existing contact with this email, so the case is not linked to a person yet.)') + result.attachNote;
      } catch (error) {
        console.error('support_salesforce_failed', error.message);
        note = '\n\nThis could not be saved to Salesforce (' + error.message.slice(0, 200) + '). Please create the case by hand.' + (shot ? ' They attached a screenshot that was not saved; ask them to email it.' : '');
      }
    } else {
      note = '\n\nSalesforce is not connected, so no case was created.' + (shot ? ' They attached a screenshot that was not saved; ask them to email it.' : '');
    }
    const mail = env.CONTACT_MAIL.send({
      from: 'hello@positivetribes.org', to: env.CONTACT_TO, replyTo: req.email,
      subject: (result ? 'Support case ' + result.caseNumber : 'Support request') + ': [' + TOOLS[req.tool] + '] ' + req.summary + (req.impact === 'blocked' ? ' (urgent)' : ''),
      text: 'New support request from the Positive Tribes website.\n\n' + summary + note
    });
    // Once the case exists, a failed notice is only logged: reporting an error would invite a duplicate case.
    if (result) { try { await mail; } catch (error) { console.error('support_notice_failed', error.message); } }
    else await mail;
    return json({ ok: true, caseNumber: result?.caseNumber || null });
  } catch (error) {
    console.error('support_failed', error.code || error.message || 'unknown');
    return json({ error: 'Your request could not be sent. Please try again or email hello@positivetribes.org.' }, 503);
  }
}
