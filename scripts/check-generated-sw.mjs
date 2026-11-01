import fs from 'node:fs';

const source = fs.readFileSync('dist/sw.js', 'utf8');
const install = source.split("self.addEventListener('activate'")[0] ?? '';
if (!install || install.includes('skipWaiting')) {
  console.error('Generated install handler must not call skipWaiting.');
  process.exit(1);
}
if (!source.includes('SKIP_WAITING') || !source.includes('GET_RELEASE')) {
  console.error('Generated worker is missing the release message contract.');
  process.exit(1);
}
