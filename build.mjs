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

await mkdir('public', { recursive: true });
for (const page of ['index.html', 'about.html', 'projects.html', 'contact.html', 'volunteer.html', 'privacy.html']) {
  const html = await readFile(page, 'utf8');
  if (!html.includes('</head>')) throw new Error(`${page} is missing </head>.`);
  await writeFile(`public/${page}`, html.replace('</head>', analytics + '</head>'));
}
for (const screen of ['workouts', 'training-frequency', 'blood-pressure', 'medicine-tracker']) {
  await copyFile(`pulselift-${screen}.png`, `public/pulselift-${screen}.png`);
}
await copyFile('positive-tribes-community.jpg', 'public/positive-tribes-community.jpg');
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
await cp('soberafe', 'public/soberafe', { recursive: true });
await cp('card', 'public/card', { recursive: true });
// Optional folder: git drops it when empty, so skip it rather than fail the deploy.
if (existsSync('lutheran-hospital')) await cp('lutheran-hospital', 'public/lutheran-hospital', { recursive: true });
await writeFile('wrangler.json', JSON.stringify({
  name: 'positivetribes', main: 'contact-worker.mjs', compatibility_date: '2026-09-11',
  assets: { directory: './public', binding: 'ASSETS', run_worker_first: true }, observability: { enabled: true },
  vars: { CONTACT_TO: recipient },
  send_email: [{ name: 'CONTACT_MAIL', destination_address: recipient }],
  ratelimits: [{ name: 'CONTACT_LIMIT', namespace_id: '914202601', simple: { limit: 5, period: 60 } }]
}, null, 2));
console.log(`Prepared website assets and contact form configuration${measurementId ? ` with GA4 ${measurementId}` : ' without analytics'}.`);
