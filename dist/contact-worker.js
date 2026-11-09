var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// donations.mjs
var STRIPE_API = "https://api.stripe.com/v1";
var json = /* @__PURE__ */ __name((data, status = 200) => Response.json(data, { status, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } }), "json");
var MIN_DOLLARS = 5;
var MAX_DOLLARS = 25e3;
var TIERS = ["Supporter", "Builder", "Partner", "Champion", "Custom"];
var donationsEnabled = /* @__PURE__ */ __name((env) => (env.DONATIONS === "preview" || env.DONATIONS === "on") && !!env.STRIPE_SECRET_KEY, "donationsEnabled");
async function stripe(env, path, params) {
  const response = await fetch(STRIPE_API + path, {
    method: "POST",
    headers: { Authorization: "Bearer " + env.STRIPE_SECRET_KEY, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params)
  });
  const data = await response.json();
  if (!response.ok) throw new Error("stripe_" + (data.error?.code || response.status));
  return data;
}
__name(stripe, "stripe");
async function createCheckout(request, env, url) {
  if (!donationsEnabled(env)) return json({ error: "Online giving is not open yet. Please email hello@positivetribes.org." }, 404);
  if (request.method !== "POST") return json({ error: "Please use the donation form." }, 405);
  if (request.headers.get("Origin") !== url.origin || !["positivetribes.org", "www.positivetribes.org"].includes(url.hostname)) {
    return json({ error: "Please give from the Positive Tribes website." }, 403);
  }
  if (!request.headers.get("Content-Type")?.startsWith("application/json")) return json({ error: "Invalid request." }, 415);
  const { success } = await env.DONATE_LIMIT.limit({ key: "donate:" + (request.headers.get("CF-Connecting-IP") || "unknown") });
  if (!success) return json({ error: "Please wait a minute before trying again." }, 429);
  let data;
  try {
    const text2 = await request.text();
    if (text2.length > 2e3) throw new Error("large");
    data = JSON.parse(text2);
  } catch {
    return json({ error: "Invalid request." }, 400);
  }
  const { amount, frequency, tier, website } = data || {};
  if (website) return json({ error: "Invalid request." }, 400);
  if (!Number.isInteger(amount) || amount < MIN_DOLLARS || amount > MAX_DOLLARS) return json({ error: "Please enter a whole-dollar amount between $5 and $25,000." }, 400);
  if (frequency !== "once" && frequency !== "monthly") return json({ error: "Please choose one time or monthly." }, 400);
  const tierName = TIERS.includes(tier) ? tier : "Custom";
  const monthly = frequency === "monthly";
  const params = {
    mode: monthly ? "subscription" : "payment",
    "line_items[0][quantity]": "1",
    "line_items[0][price_data][currency]": "usd",
    "line_items[0][price_data][unit_amount]": String(amount * 100),
    "line_items[0][price_data][product_data][name]": monthly ? "Monthly gift to Positive Tribes" : "Gift to Positive Tribes",
    billing_address_collection: "required",
    // The thank-you page reports the amount to Google Ads as the conversion value; the session id
    // lets Ads drop a repeat of the same gift (a reload or a second tab).
    success_url: url.origin + "/donate.html?thanks=1&amount=" + amount + "&frequency=" + frequency + "&gift={CHECKOUT_SESSION_ID}",
    cancel_url: url.origin + "/donate.html",
    "custom_text[submit][message]": "Positive Tribes is a 501(c)(3) nonprofit (EIN 99-2221407). No goods or services are provided in exchange for your gift.",
    "metadata[tier]": tierName,
    "metadata[frequency]": frequency
  };
  if (monthly) {
    params["line_items[0][price_data][recurring][interval]"] = "month";
    params["subscription_data[metadata][tier]"] = tierName;
    params["subscription_data[description]"] = "Monthly gift to Positive Tribes";
  } else {
    params.submit_type = "donate";
    params.customer_creation = "always";
    params["payment_intent_data[description]"] = "Gift to Positive Tribes";
    params["payment_intent_data[metadata][tier]"] = tierName;
  }
  try {
    const session = await stripe(env, "/checkout/sessions", params);
    return json({ url: session.url });
  } catch (error) {
    console.error("donate_checkout_failed", error.message);
    return json({ error: "Checkout could not be opened. Please try again or email hello@positivetribes.org." }, 502);
  }
}
__name(createCheckout, "createCheckout");
async function verifyStripe(body, header, secret) {
  const parts = Object.fromEntries((header || "").split(",").map((p) => p.split("=")).filter((p) => p.length === 2 && p[0] !== "v1"));
  const signatures = (header || "").split(",").filter((p) => p.startsWith("v1=")).map((p) => p.slice(3));
  const timestamp = Number(parts.t);
  if (!timestamp || !signatures.length || Math.abs(Date.now() / 1e3 - timestamp) > 300) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(timestamp + "." + body)));
  const expected = [...mac].map((b) => b.toString(16).padStart(2, "0")).join("");
  return signatures.some((sig) => sig.length === expected.length && [...sig].reduce((diff, c, i) => diff | c.charCodeAt(0) ^ expected.charCodeAt(i), 0) === 0);
}
__name(verifyStripe, "verifyStripe");
var denverDate = /* @__PURE__ */ __name((seconds) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Denver" }).format(new Date(seconds * 1e3)), "denverDate");
function giftFromEvent(event) {
  const o = event.data.object;
  if ((event.type === "checkout.session.completed" || event.type === "checkout.session.async_payment_succeeded") && o.mode === "payment" && o.payment_status === "paid") {
    return {
      reference: o.payment_intent,
      amount: o.amount_total / 100,
      date: denverDate(o.created),
      recurring: false,
      name: o.customer_details?.name || "",
      email: o.customer_details?.email || "",
      address: o.customer_details?.address || {},
      tier: o.metadata?.tier || "Custom"
    };
  }
  if (event.type === "invoice.paid" && o.amount_paid > 0) {
    const subscription = o.subscription || o.parent?.subscription_details?.subscription || "";
    if (!subscription) return null;
    return {
      reference: o.id,
      subscription,
      amount: o.amount_paid / 100,
      date: denverDate(o.status_transitions?.paid_at || o.created),
      recurring: true,
      name: o.customer_name || "",
      email: o.customer_email || "",
      address: o.customer_address || {},
      tier: o.parent?.subscription_details?.metadata?.tier || o.subscription_details?.metadata?.tier || "Custom"
    };
  }
  return null;
}
__name(giftFromEvent, "giftFromEvent");
async function salesforceToken(env) {
  const response = await fetch(env.SF_DOMAIN.replace(/\/$/, "") + "/services/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "client_credentials", client_id: env.SF_CLIENT_ID, client_secret: env.SF_CLIENT_SECRET })
  });
  const data = await response.json();
  if (!response.ok) throw new Error("sf_auth_" + (data.error || response.status));
  return data;
}
__name(salesforceToken, "salesforceToken");
async function sf(auth, method, path, body) {
  const response = await fetch(auth.instance_url + "/services/data/v62.0" + path, {
    method,
    headers: { Authorization: "Bearer " + auth.access_token, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : void 0
  });
  const data = response.status === 204 ? null : await response.json();
  if (!response.ok) throw new Error("sf_" + response.status + " " + JSON.stringify(data).slice(0, 300));
  return data;
}
__name(sf, "sf");
var soql = /* @__PURE__ */ __name((auth, q) => sf(auth, "GET", "/query?q=" + encodeURIComponent(q)), "soql");
var quote = /* @__PURE__ */ __name((s) => "'" + String(s).replace(/\\/g, "\\\\").replace(/'/g, "\\'") + "'", "quote");
async function donorAccount(auth, gift) {
  if (gift.email) {
    const found = await soql(auth, "SELECT Id FROM Account WHERE IsPersonAccount = true AND PersonEmail = " + quote(gift.email) + " ORDER BY CreatedDate LIMIT 1");
    if (found.records.length) return found.records[0].Id;
  }
  const type = await soql(auth, "SELECT Id FROM RecordType WHERE SobjectType = 'Account' AND IsPersonType = true AND IsActive = true LIMIT 1");
  const words = gift.name.trim().split(/\s+/).filter(Boolean);
  const lastName = words.length > 1 ? words.pop() : words.pop() || gift.email.split("@")[0] || "Donor";
  const a = gift.address;
  const created = await sf(auth, "POST", "/sobjects/Account", {
    RecordTypeId: type.records[0]?.Id,
    FirstName: words.join(" ") || null,
    LastName: lastName.slice(0, 80),
    PersonEmail: gift.email || null,
    PersonMailingStreet: [a.line1, a.line2].filter(Boolean).join("\n") || null,
    PersonMailingCity: a.city || null,
    PersonMailingState: a.state || null,
    PersonMailingPostalCode: a.postal_code || null,
    PersonMailingCountry: a.country || null
  });
  return created.id;
}
__name(donorAccount, "donorAccount");
async function recordGift(env, gift) {
  const auth = await salesforceToken(env);
  const existing = await soql(auth, "SELECT Id FROM GiftTransaction WHERE ProcessorReference = " + quote(gift.reference) + " LIMIT 1");
  if (existing.records.length) return { id: existing.records[0].Id, created: false };
  const donorId = await donorAccount(auth, gift);
  const created = await sf(auth, "POST", "/sobjects/GiftTransaction", {
    Name: (gift.recurring ? "Monthly gift" : "Online gift") + " " + gift.date,
    DonorId: donorId,
    OriginalAmount: gift.amount,
    TransactionDate: gift.date,
    Status: "Paid",
    GiftType: "Individual",
    PaymentMethod: "Credit Card",
    ProcessorReference: gift.reference,
    Description: "Stripe " + (gift.recurring ? "monthly gift, subscription " + gift.subscription : "one-time gift") + " \xB7 tier " + gift.tier
  });
  return { id: created.id, created: true };
}
__name(recordGift, "recordGift");
var giftSummary = /* @__PURE__ */ __name((gift) => `$${gift.amount.toFixed(2)} ${gift.recurring ? "monthly" : "one-time"} gift on ${gift.date}
Donor: ${gift.name} <${gift.email}>
Tier: ${gift.tier}
Stripe reference: ${gift.reference}`, "giftSummary");
async function stripeWebhook(request, env) {
  if (request.method !== "POST" || !env.STRIPE_WEBHOOK_SECRET) return json({ error: "Not found." }, 404);
  const body = await request.text();
  if (body.length > 5e5 || !await verifyStripe(body, request.headers.get("Stripe-Signature"), env.STRIPE_WEBHOOK_SECRET)) return json({ error: "Invalid signature." }, 400);
  const event = JSON.parse(body);
  const gift = giftFromEvent(event);
  if (!gift) return json({ received: true });
  if (!env.SF_DOMAIN || !env.SF_CLIENT_ID || !env.SF_CLIENT_SECRET) {
    await env.CONTACT_MAIL.send({ from: "hello@positivetribes.org", to: env.CONTACT_TO, subject: "New donation (not yet in Salesforce)", text: giftSummary(gift) });
    return json({ received: true });
  }
  try {
    const { id, created } = await recordGift(env, gift);
    console.log("donation_recorded", gift.reference, id);
    if (created) {
      const link = env.SF_DOMAIN.replace(/\/$/, "") + "/lightning/r/GiftTransaction/" + id + "/view";
      try {
        await env.CONTACT_MAIL.send({ from: "hello@positivetribes.org", to: env.CONTACT_TO, subject: "New donation: $" + gift.amount.toFixed(2) + (gift.recurring ? " monthly" : ""), text: giftSummary(gift) + "\n\nIn Salesforce: " + link });
      } catch (error) {
        console.error("donation_email_failed", gift.reference, error.message);
      }
    }
    return json({ received: true });
  } catch (error) {
    console.error("donation_sync_failed", gift.reference, error.message);
    try {
      await env.CONTACT_MAIL.send({ from: "hello@positivetribes.org", to: env.CONTACT_TO, subject: "Donation not recorded in Salesforce", text: giftSummary(gift) + "\n\nError: " + error.message + "\n\nStripe will retry automatically." });
    } catch {
    }
    return json({ error: "Sync failed." }, 500);
  }
}
__name(stripeWebhook, "stripeWebhook");

// support.mjs
var json2 = /* @__PURE__ */ __name((data, status = 200) => Response.json(data, { status, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } }), "json");
var TOOLS = { pulselift: "PulseLift", "climb-partners": "Climb Partners", "volunteer-connect": "Volunteer Connect", "partner-tool": "A tool built for my organization", other: "Something else" };
var KINDS = { broken: ["Something\u2019s broken", "Problem"], howto: ["How do I\u2026?", "Question"], idea: ["Feature idea", "Feature Request"], access: ["Account or access", "Question"] };
var IMPACTS = { minor: ["Minor annoyance", "Low"], slowing: ["Slowing us down", "Medium"], blocked: ["We can\u2019t work", "High"] };
var MAX_FILE = 5 * 1024 * 1024;
var text = /* @__PURE__ */ __name((form, key) => {
  const v = form.get(key);
  return typeof v === "string" ? v.trim() : "";
}, "text");
var oneLine = /* @__PURE__ */ __name((s) => !/[\x00-\x1f\x7f]/.test(s), "oneLine");
async function readScreenshot(file) {
  if (!file || typeof file === "string" || file.size === 0) return null;
  if (file.size > MAX_FILE) throw new Error("size");
  const bytes = new Uint8Array(await file.arrayBuffer());
  const png = bytes[0] === 137 && bytes[1] === 80 && bytes[2] === 78 && bytes[3] === 71;
  const jpeg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  if (!png && !jpeg) throw new Error("type");
  return { bytes, ext: png ? "png" : "jpg" };
}
__name(readScreenshot, "readScreenshot");
function base64(bytes) {
  let out = "";
  for (let i = 0; i < bytes.length; i += 32768) out += String.fromCharCode.apply(null, bytes.subarray(i, i + 32768));
  return btoa(out);
}
__name(base64, "base64");
async function createCase(env, req, shot) {
  const auth = await salesforceToken(env);
  const found = await soql(auth, "SELECT Id, AccountId FROM Contact WHERE Email = " + quote(req.email) + " ORDER BY LastModifiedDate DESC LIMIT 1");
  const contact = found.records[0];
  const { id } = await sf(auth, "POST", "/sobjects/Case", {
    Subject: ("[" + TOOLS[req.tool] + "] " + req.summary).slice(0, 255),
    Description: req.description,
    Origin: "Web",
    Status: "New",
    Type: KINDS[req.kind][1],
    Priority: IMPACTS[req.impact][1],
    SuppliedName: req.name.slice(0, 80),
    SuppliedEmail: req.email.slice(0, 80),
    SuppliedCompany: req.org ? req.org.slice(0, 80) : void 0,
    ContactId: contact?.Id,
    AccountId: contact?.AccountId || void 0
  });
  const { CaseNumber } = await sf(auth, "GET", "/sobjects/Case/" + id + "?fields=CaseNumber");
  let attachNote = "";
  if (shot) {
    try {
      await sf(auth, "POST", "/sobjects/ContentVersion", { Title: "Screenshot from " + req.name, PathOnClient: "screenshot." + shot.ext, VersionData: base64(shot.bytes), FirstPublishLocationId: id });
    } catch (error) {
      console.error("support_attach_failed", error.message);
      attachNote = "\nThe screenshot could not be attached (" + error.message.slice(0, 150) + "). Ask them to send it by email.";
    }
  }
  return { caseNumber: CaseNumber, link: env.SF_DOMAIN.replace(/\/$/, "") + "/lightning/r/Case/" + id + "/view", matched: !!contact, attachNote };
}
__name(createCase, "createCase");
async function handleSupport(request, env, url) {
  if (request.method !== "POST") return json2({ error: "Please use the support form." }, 405);
  if (request.headers.get("Origin") !== url.origin || !["positivetribes.org", "www.positivetribes.org"].includes(url.hostname)) {
    return json2({ error: "Please submit from the Positive Tribes website." }, 403);
  }
  if (!request.headers.get("Content-Type")?.startsWith("multipart/form-data")) return json2({ error: "Invalid request." }, 415);
  if (Number(request.headers.get("Content-Length") || 0) > MAX_FILE + 2e5) return json2({ error: "That screenshot is too large. Please use one under 5 MB." }, 413);
  try {
    const { success } = await env.SUPPORT_LIMIT.limit({ key: "support:" + (request.headers.get("CF-Connecting-IP") || "unknown") });
    if (!success) return json2({ error: "Please wait a minute before sending another request." }, 429);
    let form;
    try {
      form = await request.formData();
    } catch {
      return json2({ error: "Please check the form and try again." }, 400);
    }
    if (text(form, "website")) return json2({ error: "Please check the form and try again." }, 400);
    const req = {
      name: text(form, "name"),
      email: text(form, "email"),
      org: text(form, "org"),
      tool: text(form, "tool"),
      kind: text(form, "kind"),
      impact: text(form, "impact"),
      summary: text(form, "summary"),
      description: text(form, "description")
    };
    if (!req.name || req.name.length > 100 || !oneLine(req.name) || req.org.length > 100 || !oneLine(req.org) || req.email.length > 254 || !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(req.email) || !oneLine(req.email) || !Object.hasOwn(TOOLS, req.tool) || !Object.hasOwn(KINDS, req.kind) || !Object.hasOwn(IMPACTS, req.impact) || req.summary.length < 5 || req.summary.length > 120 || !oneLine(req.summary) || req.description.length < 10 || req.description.length > 5e3) {
      return json2({ error: "Please fill in every field. The summary needs 5 to 120 characters and the details 10 to 5,000." }, 400);
    }
    let shot;
    try {
      shot = await readScreenshot(form.get("screenshot"));
    } catch (error) {
      return json2({ error: error.message === "size" ? "That screenshot is too large. Please use one under 5 MB." : "Screenshots need to be PNG or JPG images." }, 400);
    }
    const summary = "Tool: " + TOOLS[req.tool] + "\nRequest: " + KINDS[req.kind][0] + "\nImpact: " + IMPACTS[req.impact][0] + "\nName: " + req.name + "\nEmail: " + req.email + (req.org ? "\nOrganization: " + req.org : "") + "\n\nSummary: " + req.summary + "\n\n" + req.description;
    let result = null, note;
    if (env.SF_DOMAIN && env.SF_CLIENT_ID && env.SF_CLIENT_SECRET) {
      try {
        result = await createCase(env, req, shot);
        note = "\n\nIn Salesforce: " + result.link + (result.matched ? "" : "\n(No existing contact with this email, so the case is not linked to a person yet.)") + result.attachNote;
      } catch (error) {
        console.error("support_salesforce_failed", error.message);
        note = "\n\nThis could not be saved to Salesforce (" + error.message.slice(0, 200) + "). Please create the case by hand." + (shot ? " They attached a screenshot that was not saved; ask them to email it." : "");
      }
    } else {
      note = "\n\nSalesforce is not connected, so no case was created." + (shot ? " They attached a screenshot that was not saved; ask them to email it." : "");
    }
    const mail = env.CONTACT_MAIL.send({
      from: "hello@positivetribes.org",
      to: env.CONTACT_TO,
      replyTo: req.email,
      subject: (result ? "Support case " + result.caseNumber : "Support request") + ": [" + TOOLS[req.tool] + "] " + req.summary + (req.impact === "blocked" ? " (urgent)" : ""),
      text: "New support request from the Positive Tribes website.\n\n" + summary + note
    });
    if (result) {
      try {
        await mail;
      } catch (error) {
        console.error("support_notice_failed", error.message);
      }
    } else await mail;
    return json2({ ok: true, caseNumber: result?.caseNumber || null });
  } catch (error) {
    console.error("support_failed", error.code || error.message || "unknown");
    return json2({ error: "Your request could not be sent. Please try again or email hello@positivetribes.org." }, 503);
  }
}
__name(handleSupport, "handleSupport");

// card-share.mjs
var json3 = /* @__PURE__ */ __name((data, status = 200) => Response.json(data, { status, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } }), "json");
var HOSTS = ["card.positivetribes.org", "positivetribes.org", "www.positivetribes.org"];
var LIMITS = { name: 100, phone: 40, email: 254, company: 100, note: 1e3 };
var field = /* @__PURE__ */ __name((data, key) => typeof data[key] === "string" ? data[key].trim() : "", "field");
var vcf = /* @__PURE__ */ __name((s) => s.replace(/\\/g, "\\\\").replace(/[,;]/g, (c) => "\\" + c).replace(/\r?\n/g, "\\n"), "vcf");
function contactCard({ name, phone, email, company, note }) {
  const parts = name.split(/\s+/);
  const last = parts.length > 1 ? parts.pop() : "";
  const lines = ["BEGIN:VCARD", "VERSION:3.0", "N:" + vcf(last) + ";" + vcf(parts.join(" ")) + ";;;", "FN:" + vcf(name)];
  if (company) lines.push("ORG:" + vcf(company));
  if (phone) lines.push("TEL;type=CELL;type=VOICE:" + vcf(phone));
  if (email) lines.push("EMAIL;type=INTERNET:" + vcf(email));
  const met = "Shared via card.positivetribes.org on " + (/* @__PURE__ */ new Date()).toISOString().slice(0, 10);
  lines.push("NOTE:" + vcf(note ? note + "\n\n" + met : met), "END:VCARD", "");
  return lines.join("\r\n");
}
__name(contactCard, "contactCard");
async function handleCardShare(request, env, url, readBody2) {
  if (request.method !== "POST") return json3({ error: "Please use the form on the card." }, 405);
  if (request.headers.get("Origin") !== url.origin || !HOSTS.includes(url.hostname)) return json3({ error: "Please submit from the card page." }, 403);
  if (!request.headers.get("Content-Type")?.startsWith("application/json")) return json3({ error: "Invalid request." }, 415);
  try {
    const { success } = await env.CONTACT_LIMIT.limit({ key: "card:" + (request.headers.get("CF-Connecting-IP") || "unknown") });
    if (!success) return json3({ error: "Please wait a minute before trying again." }, 429);
    let data;
    try {
      data = await readBody2(request);
    } catch {
      return json3({ error: "Please check the form and try again." }, 400);
    }
    if (!data || typeof data !== "object" || Array.isArray(data) || data.website) return json3({ error: "Please check the form and try again." }, 400);
    const person = Object.fromEntries(Object.keys(LIMITS).map((key) => [key, field(data, key)]));
    for (const key of ["name", "phone", "email", "company"]) {
      if (person[key].length > LIMITS[key] || /[\x00-\x1f\x7f]/.test(person[key])) return json3({ error: "Please check the form and try again." }, 400);
    }
    if (person.note.length > LIMITS.note || /[\x00-\x09\x0b-\x1f\x7f]/.test(person.note)) return json3({ error: "Please keep the note under 1,000 characters." }, 400);
    if (!person.name) return json3({ error: "Please add your name." }, 400);
    if (!person.phone && !person.email) return json3({ error: "Please add a phone number or email." }, 400);
    if (person.email && !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(person.email)) return json3({ error: "Please check your email address." }, 400);
    if (person.phone && !/^[+()\d\s.-]{7,40}$/.test(person.phone)) return json3({ error: "Please check your phone number." }, 400);
    const rows = [["Name", person.name], ["Phone", person.phone], ["Email", person.email], ["Company", person.company]].filter(([, v]) => v);
    const text2 = "Someone shared their contact info from your card.\n\n" + rows.map(([k, v]) => k + ": " + v).join("\n") + (person.note ? "\n\nNote:\n" + person.note : "") + "\n\nTap the attached contact file to save them.";
    await env.CONTACT_MAIL.send({
      from: "hello@positivetribes.org",
      to: env.CONTACT_TO,
      replyTo: person.email || void 0,
      subject: "New contact from your card: " + person.name,
      text: text2,
      attachments: [{ content: new TextEncoder().encode(contactCard(person)), filename: (person.name.replace(/[^\w .-]/g, "").trim() || "contact") + ".vcf", type: "text/vcard", disposition: "attachment" }]
    });
    return json3({ ok: true });
  } catch (error) {
    console.error("card_share_failed", error.code || error.message || "unknown");
    return json3({ error: "That didn\u2019t go through. Please try again, or text Eric at (720) 762-0570." }, 503);
  }
}
__name(handleCardShare, "handleCardShare");

// contact-worker.mjs
var COMMAND_CENTER = "https://hub.positivetribes.org/#/command";
var COMMAND_CENTER_API = "https://hub.positivetribes.org/api/admin/";
var isAdminPath = /* @__PURE__ */ __name((pathname) => {
  let path = pathname;
  try {
    path = decodeURIComponent(pathname);
  } catch {
  }
  return /^\/+(api\/+)?admin(\/|\.|$)/i.test(path);
}, "isAdminPath");
var REASONS = { general: "General question or idea", project: "A nonprofit project idea", pulselift: "PulseLift tester request", volunteer: "Volunteering", climbpartners: "Climb Partners invite request" };
var CAMPAIGNS = { pulselift: "PulseLift Testers", volunteer: "Volunteers" };
var VOLUNTEER_ROLES = ["Build (developer or designer)", "Test or advise", "Connect us with a nonprofit", "Something else"];
var salesforceReady = /* @__PURE__ */ __name((env) => !!(env.SF_DOMAIN && env.SF_CLIENT_ID && env.SF_CLIENT_SECRET), "salesforceReady");
async function saveLead(env, { name, email, message, reason, role }) {
  const auth = await salesforceToken(env);
  const stamp = (/* @__PURE__ */ new Date()).toISOString().slice(0, 10);
  const entry = "[" + stamp + "] " + REASONS[reason] + "\n" + message;
  const found = await soql(auth, "SELECT Id, Description FROM Lead WHERE Email = " + quote(email) + " AND IsConverted = false ORDER BY CreatedDate DESC LIMIT 1");
  let id;
  if (found.records.length) {
    id = found.records[0].Id;
    const description = (entry + "\n\n" + (found.records[0].Description || "")).slice(0, 32e3);
    await sf(auth, "PATCH", "/sobjects/Lead/" + id, { Description: description });
  } else {
    const parts = name.split(/\s+/);
    const lastName = parts.pop();
    const firstName = parts.join(" ").slice(0, 40) || void 0;
    id = (await sf(auth, "POST", "/sobjects/Lead", { FirstName: firstName, LastName: lastName.slice(0, 80), Email: email, LeadSource: "Web", Description: entry })).id;
  }
  if (CAMPAIGNS[reason]) {
    const campaign = await soql(auth, "SELECT Id FROM Campaign WHERE Name = " + quote(CAMPAIGNS[reason]) + " LIMIT 1");
    if (!campaign.records.length) throw new Error("campaign_missing");
    const campaignId = campaign.records[0].Id;
    const extra = reason === "volunteer" && role ? { Volunteer_Role__c: role } : {};
    const member = await soql(auth, "SELECT Id FROM CampaignMember WHERE CampaignId = " + quote(campaignId) + " AND LeadId = " + quote(id) + " LIMIT 1");
    if (member.records.length) {
      if (extra.Volunteer_Role__c) await sf(auth, "PATCH", "/sobjects/CampaignMember/" + member.records[0].Id, extra);
    } else await sf(auth, "POST", "/sobjects/CampaignMember", { CampaignId: campaignId, LeadId: id, Status: "Responded", ...extra });
  }
  return env.SF_DOMAIN.replace(/\/$/, "") + "/lightning/r/Lead/" + id + "/view";
}
__name(saveLead, "saveLead");
var json4 = /* @__PURE__ */ __name((data, status = 200) => Response.json(data, { status, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } }), "json");
async function readBody(request) {
  if (!request.body) throw new Error("empty");
  const reader = request.body.getReader();
  const chunks = [];
  let length = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > 24e3) {
      await reader.cancel();
      throw new Error("large");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return JSON.parse(new TextDecoder().decode(bytes));
}
__name(readBody, "readBody");
var contact_worker_default = {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (isAdminPath(url.pathname)) {
      const headers = { "Cache-Control": "no-store", "X-Robots-Tag": "noindex" };
      if (/^\/+api\//i.test(url.pathname)) return Response.json({ error: "moved", url: COMMAND_CENTER_API }, { status: 410, headers });
      return new Response(null, { status: 302, headers: { ...headers, Location: COMMAND_CENTER } });
    }
    if (url.pathname === "/api/card-share") return handleCardShare(request, env, url, readBody);
    if (url.hostname === "card.positivetribes.org" && !/^\/(fonts|brand)\//.test(url.pathname)) {
      url.pathname = "/card" + url.pathname;
      return env.ASSETS.fetch(new Request(url, request));
    }
    if (url.pathname === "/api/support") return handleSupport(request, env, url);
    if (url.pathname === "/api/donate") return createCheckout(request, env, url);
    if (url.pathname === "/api/stripe-webhook") return stripeWebhook(request, env);
    if (url.pathname === "/donate.html" || url.pathname === "/donate") {
      if (!donationsEnabled(env)) return Response.redirect(url.origin + "/", 302);
    }
    if (url.pathname !== "/api/contact") return env.ASSETS.fetch(request);
    if (request.method !== "POST") return json4({ error: "Please use the contact form." }, 405);
    if (request.headers.get("Origin") !== url.origin || !["positivetribes.org", "www.positivetribes.org"].includes(url.hostname)) {
      return json4({ error: "Please submit from the Positive Tribes website." }, 403);
    }
    if (!request.headers.get("Content-Type")?.startsWith("application/json")) return json4({ error: "Invalid request." }, 415);
    try {
      const { success } = await env.CONTACT_LIMIT.limit({ key: "contact:" + (request.headers.get("CF-Connecting-IP") || "unknown") });
      if (!success) return json4({ error: "Please wait a minute before trying again." }, 429);
      let data;
      try {
        data = await readBody(request);
      } catch {
        return json4({ error: "Please check your message and try again." }, 400);
      }
      if (!data || typeof data !== "object" || Array.isArray(data)) return json4({ error: "Invalid form data." }, 400);
      const { name, email, message, website } = data;
      const reason = Object.hasOwn(REASONS, data.reason) ? data.reason : "general";
      if (typeof name !== "string" || typeof email !== "string" || typeof message !== "string" || website) return json4({ error: "Please check the form and try again." }, 400);
      const cleanName = name.trim(), cleanEmail = email.trim(), cleanMessage = message.trim();
      if (!cleanName || cleanName.length > 100 || /[\r\n\x00-\x1f]/.test(cleanName) || cleanEmail.length > 254 || !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(cleanEmail) || /[\x00-\x1f\x7f]/.test(cleanEmail) || cleanMessage.length < 10 || cleanMessage.length > 5e3) {
        return json4({ error: "Please enter your name, a valid email, and a message of 10\u20135,000 characters." }, 400);
      }
      let salesforceNote = "\n\nSalesforce is not connected, so this was not saved as a Lead.";
      if (salesforceReady(env)) {
        try {
          salesforceNote = "\n\nIn Salesforce: " + await saveLead(env, { name: cleanName, email: cleanEmail, message: cleanMessage, reason, role: VOLUNTEER_ROLES.includes(data.role) ? data.role : void 0 });
        } catch (error) {
          console.error("contact_salesforce_failed", error.message);
          salesforceNote = "\n\nThis could not be saved to Salesforce (" + error.message.slice(0, 200) + "). Please add it by hand.";
        }
      }
      await env.CONTACT_MAIL.send({
        from: "hello@positivetribes.org",
        to: env.CONTACT_TO,
        replyTo: cleanEmail,
        subject: reason === "pulselift" ? "PulseLift tester request from the website" : reason === "volunteer" ? "New volunteer from the website" : reason === "climbpartners" ? "Climb Partners invite request from the website" : "Positive Tribes website message",
        text: "New message from the Positive Tribes contact form.\n\nReason: " + REASONS[reason] + "\nName: " + cleanName + "\nEmail: " + cleanEmail + "\n\n" + cleanMessage + salesforceNote
      });
      return json4({ ok: true });
    } catch (error) {
      console.error("contact_delivery_failed", error.code || "unknown");
      return json4({ error: "Your message could not be sent. Please try again or email hello@positivetribes.org." }, 503);
    }
  }
};
export {
  contact_worker_default as default
};
//# sourceMappingURL=contact-worker.js.map
