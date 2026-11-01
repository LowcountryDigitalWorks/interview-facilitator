import { defineConfig, type Plugin } from 'vite';

type NodeFileApi = {
  existsSync(path: string): boolean;
  writeFileSync(path: string, data: string): void;
};

function loadNodeFileApi(): Promise<NodeFileApi> {
  return (new Function('return import("node:fs")') as () => Promise<NodeFileApi>)();
}

function outputFile(directory: string, name: string): string {
  const separator = directory.includes('\\') ? '\\' : '/';
  return directory.endsWith(separator) ? `${directory}${name}` : `${directory}${separator}${name}`;
}

const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};
const releaseSource = env.APP_RELEASE || env.GITHUB_SHA || `local-${Date.now()}`;
const release = /^[A-Za-z0-9._-]{1,80}$/.test(releaseSource) ? releaseSource : `local-${Date.now()}`;

function renderShellWorker(appRelease: string, shell: string[]): string {
  return `const RELEASE = ${JSON.stringify(appRelease)};
const CACHE_PREFIX = 'interview-facilitator-shell-';
const CACHE = CACHE_PREFIX + RELEASE;
const ORDER_CACHE = 'interview-facilitator-release-order';
const SHELL = ${JSON.stringify(shell)};
const SHELL_PATHS = new Set(SHELL);
let claimOnActivate = false;

function releaseKey(pathname) {
  return pathname + '?release=' + encodeURIComponent(RELEASE);
}

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await Promise.all(SHELL.map(async (pathname) => {
      const qualified = releaseKey(pathname);
      const response = await fetch(new Request(qualified, { cache: 'reload' }));
      if (!response.ok) throw new Error('Shell precache failed for ' + qualified);
      await cache.put(qualified, response);
    }));
    if (!self.registration.active) {
      claimOnActivate = true;
      await self.skipWaiting();
    }
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const orderCache = await caches.open(ORDER_CACHE);
    const existing = await orderCache.match('/order');
    let order = [];
    if (existing) {
      try { order = await existing.json(); } catch { order = []; }
    }
    if (!Array.isArray(order)) order = [];
    order = order.filter((id) => typeof id === 'string' && id !== RELEASE);
    order.push(RELEASE);
    const retained = order.slice(-2);
    await orderCache.put('/order', new Response(JSON.stringify(retained), { headers: { 'Content-Type': 'application/json' } }));
    const keys = await caches.keys();
    await Promise.all(keys
      .filter((key) => key.startsWith(CACHE_PREFIX) && !retained.includes(key.slice(CACHE_PREFIX.length)))
      .map((key) => caches.delete(key)));
    if (claimOnActivate) await self.clients.claim();
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of windows) client.postMessage({ type: 'RELEASE_ACTIVATED', release: RELEASE, claimed: claimOnActivate });
  })());
});

self.addEventListener('message', (event) => {
  const data = event.data;
  if (!data || typeof data.type !== 'string') return;
  if (data.type === 'GET_RELEASE') {
    event.ports[0]?.postMessage({ release: RELEASE });
    return;
  }
  if (data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  const marked = url.searchParams.get('release');
  if (marked && marked !== RELEASE) return;
  if (request.cache === 'reload') return;

  const cache = () => caches.open(CACHE);
  if (request.mode === 'navigate') {
    event.respondWith(cache().then(async (opened) => (await opened.match(releaseKey('/index.html'))) ?? fetch(request)));
    return;
  }
  if (!SHELL_PATHS.has(url.pathname)) return;
  event.respondWith(cache().then(async (opened) => (await opened.match(releaseKey(url.pathname))) ?? fetch(request)));
});
`;
}

function interviewShellPlugin(appRelease: string): Plugin {
  let shell: string[] = [];
  return {
    name: 'interview-facilitator-shell-worker',
    apply: 'build',
    enforce: 'post',
    generateBundle(_options, bundle) {
      const files = Object.values(bundle).map((file) => file.fileName);
      if (!files.includes('index.html')) this.error('Shell worker did not see index.html in the final bundle.');
      if (!files.some((file) => file.startsWith('assets/') && file.endsWith('.js'))) this.error('Shell worker did not see an app script in the final bundle.');
      if (!files.some((file) => file.startsWith('assets/') && file.endsWith('.css'))) this.error('Shell worker did not see an app stylesheet in the final bundle.');
      const paths = new Set<string>(['/index.html']);
      for (const file of files) {
        if (file.startsWith('assets/') && !file.endsWith('.map')) paths.add(`/${file}`);
      }
      shell = [...paths].sort();
    },
    async writeBundle(options) {
      if (!options.dir) this.error('Shell worker requires a directory build output.');
      if (!shell.includes('/index.html')) this.error('Shell worker lost index.html before writing sw.js.');
      const fs = await loadNodeFileApi();
      const paths = new Set(shell);
      for (const name of ['manifest.webmanifest', 'icon.svg']) {
        if (fs.existsSync(`public/${name}`) || fs.existsSync(outputFile('public', name))) paths.add(`/${name}`);
      }
      const finalShell = [...paths].sort();
      fs.writeFileSync(outputFile(options.dir, 'sw.js'), renderShellWorker(appRelease, finalShell));
    },
  };
}

export default defineConfig({
  define: {
    __APP_RELEASE__: JSON.stringify(release),
  },
  build: {
    outDir: env.BUILD_OUT || 'dist',
    rollupOptions: {
      output: {
        entryFileNames: 'assets/app.js',
        chunkFileNames: 'assets/[name].js',
        assetFileNames: (assetInfo) => assetInfo.names?.some((name) => name.endsWith('.css')) || assetInfo.name?.endsWith('.css') ? 'assets/app.css' : 'assets/[name][extname]',
      },
    },
  },
  plugins: [interviewShellPlugin(release)],
});
