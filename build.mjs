import { mkdir, copyFile, writeFile, cp } from 'node:fs/promises';

const recipient = process.env.CONTACT_TO;
if (!recipient || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient)) throw new Error('Set CONTACT_TO to the verified email destination in Cloudflare build variables.');

await mkdir('public', { recursive: true });
await copyFile('index.html', 'public/index.html');
for (const page of ['about.html', 'projects.html', 'contact.html']) {
  await copyFile(page, `public/${page}`);
}
for (const screen of ['workouts', 'training-frequency', 'blood-pressure', 'medicine-tracker']) {
  await copyFile(`pulselift-${screen}.png`, `public/pulselift-${screen}.png`);
}
await copyFile('positive-tribes-community.jpg', 'public/positive-tribes-community.jpg');
await cp('fonts', 'public/fonts', { recursive: true });
await cp('brand', 'public/brand', { recursive: true });
await cp('help-a-friend', 'public/help-a-friend', { recursive: true });
await cp('coyote', 'public/coyote', { recursive: true });
await cp('soberafe', 'public/soberafe', { recursive: true });
await writeFile('wrangler.json', JSON.stringify({
  name: 'positivetribes', main: 'contact-worker.mjs', compatibility_date: '2026-09-11',
  assets: { directory: './public', binding: 'ASSETS' }, observability: { enabled: true },
  vars: { CONTACT_TO: recipient },
  send_email: [{ name: 'CONTACT_MAIL', destination_address: recipient }],
  ratelimits: [{ name: 'CONTACT_LIMIT', namespace_id: '914202601', simple: { limit: 5, period: 60 } }]
}, null, 2));
console.log('Prepared website assets and contact form configuration.');
