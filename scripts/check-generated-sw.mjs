import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync('dist/sw.js', 'utf8');

function fail(message) {
  console.error(message);
  process.exit(1);
}

if (!source.includes('GET_RELEASE') || !source.includes('SKIP_WAITING')) {
  fail('Generated worker is missing the release message contract.');
}
if (!source.includes("pathname + '?release='") || !source.includes('const firstInstall = !self.registration.active')) {
  fail('Generated worker does not precache release-qualified URLs or gate first-install skipWaiting.');
}
if (source.includes('claimOnActivate') || /^let\s+/m.test(source)) {
  fail('Generated worker still carries an install decision in mutable global state.');
}
if (!source.includes("return '/claim/' + encodeURIComponent(RELEASE)") || !source.includes('orderCache.delete(claimKey())')) {
  fail('Generated worker does not persist and consume a durable claim marker.');
}
if (!source.includes('if (claimClients) await self.clients.claim()')) {
  fail('Generated worker must claim clients only from the durable first-install marker.');
}
if (!source.includes('retained.includes')) {
  fail('Generated worker must retain the current and previous release caches.');
}
const claimCalls = source.split('self.clients.claim()').length - 1;
if (claimCalls !== 1) {
  fail('Generated worker should claim clients in exactly one gated call.');
}
const claimAt = source.indexOf('await self.clients.claim()');
const deleteAt = source.indexOf('orderCache.delete(claimKey())');
if (claimAt < 0 || deleteAt < claimAt) {
  fail('Generated worker deletes the claim marker before clients.claim() resolves.');
}

const releaseMatch = source.match(/const RELEASE = (".*");/);
if (!releaseMatch) fail('Generated worker is missing its release constant.');
const release = JSON.parse(releaseMatch[1]);
const claimPath = `/claim/${encodeURIComponent(release)}`;

function createCaches() {
  const buckets = new Map();
  return {
    async open(name) {
      if (!buckets.has(name)) buckets.set(name, new Map());
      const bucket = buckets.get(name);
      return {
        async match(key) {
          const body = bucket.get(String(key));
          return body === undefined ? undefined : new Response(body);
        },
        async put(key, response) {
          bucket.set(String(key), await response.clone().text());
        },
        async delete(key) {
          bucket.delete(String(key));
        },
      };
    },
    async keys() {
      return [...buckets.keys()];
    },
    async delete(name) {
      return buckets.delete(name);
    },
    read(name, key) {
      return buckets.get(name)?.get(key);
    },
  };
}

async function evaluate(cachesApi, active, claimBehavior = 'resolve') {
  const calls = { skipWaiting: 0, claim: 0 };
  const listeners = new Map();
  const context = vm.createContext({
    self: {
      registration: { active },
      skipWaiting() {
        calls.skipWaiting += 1;
        return Promise.resolve();
      },
      clients: {
        claim() {
          calls.claim += 1;
          return claimBehavior === 'reject' ? Promise.reject(new Error('claim failed')) : Promise.resolve();
        },
        matchAll() {
          return Promise.resolve([]);
        },
      },
      location: { origin: 'http://127.0.0.1:4188' },
      addEventListener(type, handler) {
        listeners.set(type, handler);
      },
    },
    caches: cachesApi,
    fetch: async () => new Response('shell-bytes', { status: 200 }),
    Request: function Request(input) {
      this.url = String(input);
    },
    Response,
    URL,
  });
  vm.runInContext(source, context, { filename: 'dist/sw.js' });
  return {
    calls,
    async fire(type) {
      const handler = listeners.get(type);
      if (!handler) fail(`Generated worker did not register ${type}.`);
      const tasks = [];
      handler({
        waitUntil(promise) {
          tasks.push(Promise.resolve(promise));
        },
      });
      await Promise.all(tasks);
    },
  };
}

const firstCaches = createCaches();
const firstInstall = await evaluate(firstCaches, null);
await firstInstall.fire('install');
if (firstInstall.calls.skipWaiting !== 1) fail('First install did not skip waiting.');
if (firstCaches.read('interview-facilitator-release-order', claimPath) !== '{"claim":true}') {
  fail('First install did not store a durable claim marker.');
}
const rejectedActivate = await evaluate(firstCaches, null, 'reject');
let claimRejection = null;
try {
  await rejectedActivate.fire('activate');
} catch (error) {
  claimRejection = error;
}
if (!claimRejection) fail('A rejected clients.claim() did not fail activation.');
if (rejectedActivate.calls.claim !== 1) fail('A rejected activation did not attempt clients.claim().');
if (firstCaches.read('interview-facilitator-release-order', claimPath) !== '{"claim":true}') {
  fail('A rejected clients.claim() consumed the durable claim marker.');
}
const firstActivate = await evaluate(firstCaches, null);
await firstActivate.fire('activate');
if (firstActivate.calls.claim !== 1) fail('The retried activation did not claim exactly once.');
if (firstCaches.read('interview-facilitator-release-order', claimPath) !== undefined) {
  fail('Successful claim left the marker in place.');
}

const updateCaches = createCaches();
const updateInstall = await evaluate(updateCaches, { state: 'activated' });
await updateInstall.fire('install');
if (updateInstall.calls.skipWaiting !== 0) fail('Update install called skipWaiting.');
if (updateCaches.read('interview-facilitator-release-order', claimPath) !== '{"claim":false}') {
  fail('Update install did not persist an explicit do-not-claim marker.');
}
const updateActivate = await evaluate(updateCaches, null);
await updateActivate.fire('activate');
if (updateActivate.calls.claim !== 0) fail('A restarted update worker claimed clients.');
if (updateCaches.read('interview-facilitator-release-order', claimPath) !== undefined) {
  fail('Update activation left the claim marker in place.');
}
