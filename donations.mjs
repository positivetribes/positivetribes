// Donations: Stripe Checkout sessions for /api/donate and the Stripe webhook that records paid gifts
// in Salesforce Nonprofit Cloud. Everything stays off until the DONATIONS build variable is set and
// the Stripe secrets exist (see README).

const STRIPE_API = 'https://api.stripe.com/v1';
const json = (data, status = 200) => Response.json(data, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
const MIN_DOLLARS = 5, MAX_DOLLARS = 25000;
const TIERS = ['Supporter', 'Builder', 'Partner', 'Champion', 'Custom'];

export const donationsEnabled = (env) => (env.DONATIONS === 'preview' || env.DONATIONS === 'on') && !!env.STRIPE_SECRET_KEY;

async function stripe(env, path, params) {
  const response = await fetch(STRIPE_API + path, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + env.STRIPE_SECRET_KEY, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params)
  });
  const data = await response.json();
  if (!response.ok) throw new Error('stripe_' + (data.error?.code || response.status));
  return data;
}

export async function createCheckout(request, env, url) {
  if (!donationsEnabled(env)) return json({ error: 'Online giving is not open yet. Please email hello@positivetribes.org.' }, 404);
  if (request.method !== 'POST') return json({ error: 'Please use the donation form.' }, 405);
  if (request.headers.get('Origin') !== url.origin || !['positivetribes.org', 'www.positivetribes.org'].includes(url.hostname)) {
    return json({ error: 'Please give from the Positive Tribes website.' }, 403);
  }
  if (!request.headers.get('Content-Type')?.startsWith('application/json')) return json({ error: 'Invalid request.' }, 415);
  // Card testers hammer donation forms with small charges, so each visitor gets a few checkouts a minute.
  const { success } = await env.DONATE_LIMIT.limit({ key: 'donate:' + (request.headers.get('CF-Connecting-IP') || 'unknown') });
  if (!success) return json({ error: 'Please wait a minute before trying again.' }, 429);
  let data;
  try {
    const text = await request.text();
    if (text.length > 2000) throw new Error('large');
    data = JSON.parse(text);
  } catch { return json({ error: 'Invalid request.' }, 400); }
  const { amount, frequency, tier, website } = data || {};
  if (website) return json({ error: 'Invalid request.' }, 400);
  if (!Number.isInteger(amount) || amount < MIN_DOLLARS || amount > MAX_DOLLARS) return json({ error: 'Please enter a whole-dollar amount between $5 and $25,000.' }, 400);
  if (frequency !== 'once' && frequency !== 'monthly') return json({ error: 'Please choose one time or monthly.' }, 400);
  const tierName = TIERS.includes(tier) ? tier : 'Custom';
  const monthly = frequency === 'monthly';
  const params = {
    mode: monthly ? 'subscription' : 'payment',
    'line_items[0][quantity]': '1',
    'line_items[0][price_data][currency]': 'usd',
    'line_items[0][price_data][unit_amount]': String(amount * 100),
    'line_items[0][price_data][product_data][name]': monthly ? 'Monthly gift to Positive Tribes' : 'Gift to Positive Tribes',
    billing_address_collection: 'required',
    success_url: url.origin + '/donate.html?thanks=1',
    cancel_url: url.origin + '/donate.html',
    'custom_text[submit][message]': 'Positive Tribes is a 501(c)(3) nonprofit (EIN 99-2221407). No goods or services are provided in exchange for your gift.',
    'metadata[tier]': tierName,
    'metadata[frequency]': frequency
  };
  if (monthly) {
    params['line_items[0][price_data][recurring][interval]'] = 'month';
    params['subscription_data[metadata][tier]'] = tierName;
    params['subscription_data[description]'] = 'Monthly gift to Positive Tribes';
  } else {
    params.submit_type = 'donate';
    params.customer_creation = 'always';
    params['payment_intent_data[description]'] = 'Gift to Positive Tribes';
    params['payment_intent_data[metadata][tier]'] = tierName;
  }
  try {
    const session = await stripe(env, '/checkout/sessions', params);
    return json({ url: session.url });
  } catch (error) {
    console.error('donate_checkout_failed', error.message);
    return json({ error: 'Checkout could not be opened. Please try again or email hello@positivetribes.org.' }, 502);
  }
}

// Stripe signs each webhook with HMAC-SHA256 over "timestamp.body"; reject anything unsigned or older than 5 minutes.
async function verifyStripe(body, header, secret) {
  const parts = Object.fromEntries((header || '').split(',').map((p) => p.split('=')).filter((p) => p.length === 2 && p[0] !== 'v1'));
  const signatures = (header || '').split(',').filter((p) => p.startsWith('v1=')).map((p) => p.slice(3));
  const timestamp = Number(parts.t);
  if (!timestamp || !signatures.length || Math.abs(Date.now() / 1000 - timestamp) > 300) return false;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(timestamp + '.' + body)));
  const expected = [...mac].map((b) => b.toString(16).padStart(2, '0')).join('');
  return signatures.some((sig) => sig.length === expected.length && [...sig].reduce((diff, c, i) => diff | (c.charCodeAt(0) ^ expected.charCodeAt(i)), 0) === 0);
}

const denverDate = (seconds) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Denver' }).format(new Date(seconds * 1000));

// Turns a Stripe event into one paid gift, or null when the event is not a completed payment.
// One-time gifts come from Checkout; every monthly charge (including the first) comes from invoice.paid.
function giftFromEvent(event) {
  const o = event.data.object;
  if ((event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') && o.mode === 'payment' && o.payment_status === 'paid') {
    return {
      reference: o.payment_intent, amount: o.amount_total / 100, date: denverDate(o.created), recurring: false,
      name: o.customer_details?.name || '', email: o.customer_details?.email || '', address: o.customer_details?.address || {}, tier: o.metadata?.tier || 'Custom'
    };
  }
  if (event.type === 'invoice.paid' && o.amount_paid > 0) {
    // Newer API versions moved the subscription under parent.subscription_details.
    const subscription = o.subscription || o.parent?.subscription_details?.subscription || '';
    if (!subscription) return null;
    return {
      reference: o.id, subscription, amount: o.amount_paid / 100, date: denverDate(o.status_transitions?.paid_at || o.created), recurring: true,
      name: o.customer_name || '', email: o.customer_email || '', address: o.customer_address || {}, tier: o.parent?.subscription_details?.metadata?.tier || o.subscription_details?.metadata?.tier || 'Custom'
    };
  }
  return null;
}

async function salesforceToken(env) {
  const response = await fetch(env.SF_DOMAIN.replace(/\/$/, '') + '/services/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: env.SF_CLIENT_ID, client_secret: env.SF_CLIENT_SECRET })
  });
  const data = await response.json();
  if (!response.ok) throw new Error('sf_auth_' + (data.error || response.status));
  return data;
}

async function sf(auth, method, path, body) {
  const response = await fetch(auth.instance_url + '/services/data/v62.0' + path, {
    method, headers: { Authorization: 'Bearer ' + auth.access_token, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined
  });
  const data = response.status === 204 ? null : await response.json();
  if (!response.ok) throw new Error('sf_' + response.status + ' ' + JSON.stringify(data).slice(0, 300));
  return data;
}
const soql = (auth, q) => sf(auth, 'GET', '/query?q=' + encodeURIComponent(q));
const quote = (s) => "'" + String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'";

// Finds the donor's Person Account by email, or creates one. Individuals are Person Accounts in this org.
async function donorAccount(auth, gift) {
  if (gift.email) {
    const found = await soql(auth, 'SELECT Id FROM Account WHERE IsPersonAccount = true AND PersonEmail = ' + quote(gift.email) + ' ORDER BY CreatedDate LIMIT 1');
    if (found.records.length) return found.records[0].Id;
  }
  const type = await soql(auth, "SELECT Id FROM RecordType WHERE SobjectType = 'Account' AND IsPersonType = true AND IsActive = true LIMIT 1");
  const words = gift.name.trim().split(/\s+/).filter(Boolean);
  const lastName = words.length > 1 ? words.pop() : (words.pop() || gift.email.split('@')[0] || 'Donor');
  const a = gift.address;
  const created = await sf(auth, 'POST', '/sobjects/Account', {
    RecordTypeId: type.records[0]?.Id, FirstName: words.join(' ') || null, LastName: lastName.slice(0, 80), PersonEmail: gift.email || null,
    PersonMailingStreet: [a.line1, a.line2].filter(Boolean).join('\n') || null, PersonMailingCity: a.city || null,
    PersonMailingState: a.state || null, PersonMailingPostalCode: a.postal_code || null, PersonMailingCountry: a.country || null
  });
  return created.id;
}

// Records the gift as a paid Gift Transaction. The Stripe payment or invoice id is stored in
// ProcessorReference so Stripe's webhook retries never create a second record. Returns the id and
// whether this call created it, so a retried event doesn't send a second notification.
async function recordGift(env, gift) {
  const auth = await salesforceToken(env);
  const existing = await soql(auth, 'SELECT Id FROM GiftTransaction WHERE ProcessorReference = ' + quote(gift.reference) + ' LIMIT 1');
  if (existing.records.length) return { id: existing.records[0].Id, created: false };
  const donorId = await donorAccount(auth, gift);
  const created = await sf(auth, 'POST', '/sobjects/GiftTransaction', {
    Name: (gift.recurring ? 'Monthly gift' : 'Online gift') + ' ' + gift.date,
    DonorId: donorId, OriginalAmount: gift.amount, TransactionDate: gift.date, Status: 'Paid', GiftType: 'Individual',
    PaymentMethod: 'Credit Card', ProcessorReference: gift.reference,
    Description: 'Stripe ' + (gift.recurring ? 'monthly gift, subscription ' + gift.subscription : 'one-time gift') + ' · tier ' + gift.tier
  });
  return { id: created.id, created: true };
}

const giftSummary = (gift) => `$${gift.amount.toFixed(2)} ${gift.recurring ? 'monthly' : 'one-time'} gift on ${gift.date}\nDonor: ${gift.name} <${gift.email}>\nTier: ${gift.tier}\nStripe reference: ${gift.reference}`;

export async function stripeWebhook(request, env) {
  if (request.method !== 'POST' || !env.STRIPE_WEBHOOK_SECRET) return json({ error: 'Not found.' }, 404);
  const body = await request.text();
  if (body.length > 500000 || !(await verifyStripe(body, request.headers.get('Stripe-Signature'), env.STRIPE_WEBHOOK_SECRET))) return json({ error: 'Invalid signature.' }, 400);
  const event = JSON.parse(body);
  const gift = giftFromEvent(event);
  if (!gift) return json({ received: true });
  if (!env.SF_DOMAIN || !env.SF_CLIENT_ID || !env.SF_CLIENT_SECRET) {
    // Salesforce not connected yet: email the gift so nothing is lost, and acknowledge it.
    await env.CONTACT_MAIL.send({ from: 'hello@positivetribes.org', to: env.CONTACT_TO, subject: 'New donation (not yet in Salesforce)', text: giftSummary(gift) });
    return json({ received: true });
  }
  try {
    const { id, created } = await recordGift(env, gift);
    console.log('donation_recorded', gift.reference, id);
    if (created) {
      // The gift is safely in Salesforce, so a failed notification is logged rather than retried.
      const link = env.SF_DOMAIN.replace(/\/$/, '') + '/lightning/r/GiftTransaction/' + id + '/view';
      try { await env.CONTACT_MAIL.send({ from: 'hello@positivetribes.org', to: env.CONTACT_TO, subject: 'New donation: $' + gift.amount.toFixed(2) + (gift.recurring ? ' monthly' : ''), text: giftSummary(gift) + '\n\nIn Salesforce: ' + link }); }
      catch (error) { console.error('donation_email_failed', gift.reference, error.message); }
    }
    return json({ received: true });
  } catch (error) {
    // A non-2xx reply makes Stripe retry for up to three days; the email makes sure someone also hears about it.
    console.error('donation_sync_failed', gift.reference, error.message);
    try { await env.CONTACT_MAIL.send({ from: 'hello@positivetribes.org', to: env.CONTACT_TO, subject: 'Donation not recorded in Salesforce', text: giftSummary(gift) + '\n\nError: ' + error.message + '\n\nStripe will retry automatically.' }); } catch {}
    return json({ error: 'Sync failed.' }, 500);
  }
}
