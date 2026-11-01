import fs from 'node:fs';

const source = fs.readFileSync('dist/sw.js', 'utf8');
if (!source.includes('GET_RELEASE') || !source.includes('SKIP_WAITING')) {
  console.error('Generated worker is missing the release message contract.');
  process.exit(1);
}
if (!source.includes("pathname + '?release='") || !source.includes('if (!self.registration.active)')) {
  console.error('Generated worker does not precache release-qualified URLs or gate first-install skipWaiting.');
  process.exit(1);
}
if (!source.includes('if (claimOnActivate) await self.clients.claim()')) {
  console.error('Generated worker must claim clients only on first install.');
  process.exit(1);
}
if (!source.includes('retained.includes')) {
  console.error('Generated worker must retain the current and previous release caches.');
  process.exit(1);
}
const claimCalls = source.split('self.clients.claim()').length - 1;
if (claimCalls !== 1) {
  console.error('Generated worker should claim clients in exactly one gated call.');
  process.exit(1);
}
