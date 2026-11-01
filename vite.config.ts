import { defineConfig, type Plugin } from 'vite';

const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};
const releaseSource = env.APP_RELEASE || env.GITHUB_SHA || `local-${Date.now()}`;
const release = /^[A-Za-z0-9._-]{1,80}$/.test(releaseSource) ? releaseSource : `local-${Date.now()}`;

function renderShellWorker(appRelease: string, shell: string[]): string {
  return `const RELEASE = ${JSON.stringify(appRelease)};
const CACHE_PREFIX = 'interview-facilitator-shell-';
const CACHE = CACHE_PREFIX + RELEASE;
const SHELL = ${JSON.stringify(shell)};
const SHELL_PATHS = new Set(SHELL);

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then(async (cache) => {
    await Promise.all(SHELL.map(async (path) => {
      const response = await fetch(new Request(path, { cache: 'reload' }));
      if (!response.ok) throw new Error('Shell precache failed for ' + path);
      await cache.put(path, response);
    }));
  }));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys
        .filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE)
        .map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
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
  if (request.cache === 'reload') return;

  if (request.mode === 'navigate') {
    event.respondWith(caches.open(CACHE).then(async (cache) => (await cache.match('/index.html')) ?? (await cache.match('/')) ?? fetch(request)));
    return;
  }

  if (!SHELL_PATHS.has(url.pathname)) return;
  event.respondWith(caches.open(CACHE).then(async (cache) => (await cache.match(url.pathname)) ?? fetch(request)));
});
`;
}

function interviewShellPlugin(appRelease: string): Plugin {
  return {
    name: 'interview-facilitator-shell-worker',
    apply: 'build',
    generateBundle(_options, bundle) {
      const shell = new Set(['/', '/index.html', '/manifest.webmanifest', '/icon.svg']);
      for (const file of Object.values(bundle)) {
        if (file.fileName === 'index.html' || file.fileName.startsWith('assets/')) shell.add(`/${file.fileName}`);
      }
      this.emitFile({
        type: 'asset',
        fileName: 'sw.js',
        source: renderShellWorker(appRelease, [...shell].sort()),
      });
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
