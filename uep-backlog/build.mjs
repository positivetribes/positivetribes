// Adds the Google Analytics 4 tag to the backlog page at deploy time, like the main Positive Tribes site.
// Set GA_MEASUREMENT_ID (for example G-XXXXXXXXXX) in this Worker's Cloudflare build variables.
// Without it the page ships with no analytics. The tag is added to the checked-out copy only, never committed.
import { readFile, writeFile } from 'node:fs/promises';

const id = process.env.GA_MEASUREMENT_ID;
if (id && !/^G-[A-Z0-9]+$/.test(id)) throw new Error('GA_MEASUREMENT_ID must look like G-XXXXXXXXXX.');
if (!id) {
  console.log('No GA_MEASUREMENT_ID set. The backlog page ships without analytics.');
  process.exit(0);
}

const file = 'public/index.html';
const html = await readFile(file, 'utf8');
if (html.includes('googletagmanager.com')) {
  console.log('The backlog page already has the analytics tag.');
  process.exit(0);
}
if (!html.includes('</head>')) throw new Error(`${file} is missing </head>.`);
const tag = `<script async src="https://www.googletagmanager.com/gtag/js?id=${id}"></script>
<script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments)}gtag('js',new Date());gtag('config','${id}');</script>
`;
await writeFile(file, html.replace('</head>', tag + '</head>'));
console.log(`Added the GA4 tag ${id} to the backlog page.`);
