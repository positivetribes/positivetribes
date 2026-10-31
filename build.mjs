import { mkdir, copyFile, readFile, writeFile, cp } from 'node:fs/promises';
import { existsSync } from 'node:fs';

const recipient = process.env.CONTACT_TO;
if (!recipient || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient)) throw new Error('Set CONTACT_TO to the verified email destination in Cloudflare build variables.');

// Optional GA4 tag for Google Ad Grants conversion tracking; pages ship without it when unset.
const measurementId = process.env.GA_MEASUREMENT_ID;
if (measurementId && !/^G-[A-Z0-9]+$/.test(measurementId)) throw new Error('GA_MEASUREMENT_ID must look like G-XXXXXXXXXX.');
const analytics = measurementId ? `<script async src="https://www.googletagmanager.com/gtag/js?id=${measurementId}"></script>
<script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments)}gtag('js',new Date());gtag('config','${measurementId}');
document.addEventListener('click',(event)=>{const link=event.target.closest('a[href^="mailto:"]');if(link)gtag('event','contact_email_click',{link_url:link.href})});</script>
` : '';

// Donations: "off" (default) leaves the donate page out entirely, "preview" publishes it unlinked and
// hidden from search for testing, "on" also adds Donate to the menu and the donation note to the privacy page.
const donations = process.env.DONATIONS || 'off';
if (!['off', 'preview', 'on'].includes(donations)) throw new Error('DONATIONS must be off, preview or on.');

// Admin command center: the Cloudflare Access team domain and application audience tag (not secrets).
// Without both, the Worker refuses every /admin request.
const accessTeam = process.env.ACCESS_TEAM_DOMAIN || '', accessAud = process.env.ACCESS_AUD || '';
if (accessTeam && !/^[a-z0-9-]+\.cloudflareaccess\.com$/.test(accessTeam)) throw new Error('ACCESS_TEAM_DOMAIN must look like yourteam.cloudflareaccess.com.');
if (accessAud && !/^[a-f0-9]{64}$/.test(accessAud)) throw new Error('ACCESS_AUD must be the 64-character Application Audience (AUD) tag.');
const adminDb = { binding: 'ADMIN_DB', database_name: 'positivetribes-admin-db', database_id: 'c74ab999-3171-432b-9234-da16795e7e50' };
const adminPreviewDb = { binding: 'ADMIN_DB', database_name: 'positivetribes-admin-preview-db', database_id: 'f6140db8-4e66-4952-bacc-9a71c293a8f9' };
// The client backlogs' own databases, read by the command center inbox. Each backlog Worker owns and writes its database.
const backlogDbs = [
  { binding: 'UEP_BACKLOG_DB', database_name: 'uep-backlog-db', database_id: '9bde984c-fd0c-4705-8d41-61624aec89ff' },
  { binding: 'COYOTE_BACKLOG_DB', database_name: 'coyote-backlog-db', database_id: '41321f8f-8e42-4eb8-b288-351226f7bd9b' },
  { binding: 'SOBERAFE_BACKLOG_DB', database_name: 'soberafe-backlog-db', database_id: '6f221a25-b48a-4121-8b24-16f72f83f802' }
];
const backlogPreviewDbs = [
  { binding: 'UEP_BACKLOG_DB', database_name: 'uep-backlog-preview-db', database_id: '5a1c43e9-e4c3-4bec-8751-1d586ba0c9ec' },
  { binding: 'COYOTE_BACKLOG_DB', database_name: 'coyote-backlog-preview-db', database_id: 'c7c4332e-c846-49ea-aa82-1af8fab82e19' },
  { binding: 'SOBERAFE_BACKLOG_DB', database_name: 'soberafe-backlog-preview-db', database_id: '9e9b6403-0523-4f15-864e-e9777fd864dc' }
];

await mkdir('public', { recursive: true });
const pages = ['index.html', 'about.html', 'projects.html', 'contact.html', 'volunteer.html', 'privacy.html', 'support.html'];
if (donations !== 'off') pages.push('donate.html');
for (const page of pages) {
  let html = await readFile(page, 'utf8');
  if (!html.includes('</head>')) throw new Error(`${page} is missing </head>.`);
  html = donations === 'on' ? html.replace(/<!--donations-->|<!--\/donations-->/g, '') : html.replace(/<!--donations-->[\s\S]*?<!--\/donations-->/g, '');
  if (donations === 'on' && page !== 'donate.html') html = html.replace(/(<a href="\/volunteer\.html"[^>]*>Volunteer<\/a>)/, '$1<a href="/donate.html">Donate</a>');
  if (donations === 'preview' && page === 'donate.html') html = html.replace('</head>', '<meta name="robots" content="noindex"></head>');
  await writeFile(`public/${page}`, html.replace('</head>', analytics + '</head>'));
}
for (const screen of ['workouts', 'training-frequency', 'blood-pressure', 'medicine-tracker']) {
  await copyFile(`pulselift-${screen}.png`, `public/pulselift-${screen}.png`);
}
await copyFile('positive-tribes-community.jpg', 'public/positive-tribes-community.jpg');
for (const file of ['eric-roberts.jpg', 'eric-roberts.webp', 'eric-roberts-headshot.jpg', 'rich-sonnenblick.jpg', 'glenn-hadley.jpg']) await copyFile(file, `public/${file}`);
await cp('fonts', 'public/fonts', { recursive: true });
await cp('brand', 'public/brand', { recursive: true });
await cp('help-a-friend', 'public/help-a-friend', { recursive: true });
await cp('coyote', 'public/coyote', { recursive: true });
// The prototype is copied as-is, so add the same GA4 tag here to count its visitors.
if (measurementId) {
  const coyote = await readFile('public/coyote/index.html', 'utf8');
  if (!coyote.includes('</head>')) throw new Error('coyote/index.html is missing </head>.');
  await writeFile('public/coyote/index.html', coyote.replace('</head>', analytics + '</head>'));
}
// Up ENDing Parkinson's scheduling prototype, copied as-is with the same GA4 tag as Coyote.
await cp('uep', 'public/uep', { recursive: true });
if (measurementId) {
  for (const page of ['uep/index.html', 'uep/v3/index.html']) {
    const uep = await readFile('public/' + page, 'utf8');
    if (!uep.includes('</head>')) throw new Error(page + ' is missing </head>.');
    await writeFile('public/' + page, uep.replace('</head>', analytics + '</head>'));
  }
}
// United Rocks copy of the same scheduling prototype, with the same GA4 tag.
await cp('unitedrocks', 'public/unitedrocks', { recursive: true });
if (measurementId) {
  const ur = await readFile('public/unitedrocks/index.html', 'utf8');
  if (!ur.includes('</head>')) throw new Error('unitedrocks/index.html is missing </head>.');
  await writeFile('public/unitedrocks/index.html', ur.replace('</head>', analytics + '</head>'));
}
await cp('soberafe', 'public/soberafe', { recursive: true });
// Outdoor Lab "Lab Card, connected" sketch: one self-contained page with sample data, hidden from search.
await cp('outdoorlab', 'public/outdoorlab', { recursive: true });
await cp('card', 'public/card', { recursive: true });
// Optional folder: git drops it when empty, so skip it rather than fail the deploy.
// Admin command center page: never indexed and never tagged for analytics.
await mkdir('public/admin', { recursive: true });
const admin = await readFile('admin/index.html', 'utf8');
if (!admin.includes('</head>')) throw new Error('admin/index.html is missing </head>.');
await writeFile('public/admin/index.html', admin.replace('</head>', '<meta name="robots" content="noindex"></head>'));
if (existsSync('lutheran-hospital')) await cp('lutheran-hospital', 'public/lutheran-hospital', { recursive: true });
await writeFile('wrangler.json', JSON.stringify({
  name: 'positivetribes', main: 'contact-worker.mjs', compatibility_date: '2026-09-11',
  assets: { directory: './public', binding: 'ASSETS', run_worker_first: true }, observability: { enabled: true },
  vars: { CONTACT_TO: recipient, DONATIONS: donations, ...(accessTeam && { ACCESS_TEAM_DOMAIN: accessTeam }), ...(accessAud && { ACCESS_AUD: accessAud }) },
  d1_databases: [adminDb, ...backlogDbs],
  // Pull request previews use their own database so test edits never touch real data.
  previews: { d1_databases: [adminPreviewDb, ...backlogPreviewDbs] },
  send_email: [{ name: 'CONTACT_MAIL', destination_address: recipient }],
  ratelimits: [
    { name: 'CONTACT_LIMIT', namespace_id: '914202601', simple: { limit: 5, period: 60 } },
    { name: 'DONATE_LIMIT', namespace_id: '914202602', simple: { limit: 5, period: 60 } },
    { name: 'SUPPORT_LIMIT', namespace_id: '914202603', simple: { limit: 3, period: 60 } }
  ]
}, null, 2));
console.log(`Prepared website assets and contact form configuration${measurementId ? ` with GA4 ${measurementId}` : ' without analytics'}, donations ${donations}, admin sign-in ${accessTeam && accessAud ? 'configured' : 'not configured (admin closed)'}.`);
