import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';

/** Cache every public code dependency in the background without evaluating it at first paint. */
export function pwaAssetsPlugin(): Plugin {
  // Vite removes CSS-only JavaScript chunks in its generateBundle hook.
  // Run afterward so the offline manifest names only files that will be written.
  return { name: 'kram-pwa-assets', apply: 'build', generateBundle: { order: 'post', handler(_options, bundle) {
    const assets = Object.keys(bundle).filter(file => file.startsWith('assets/') && /\.(?:js|css|woff2?|ttf|otf|png|svg|webp|avif|jpe?g|gif)$/.test(file)).sort().map(file => `/${file}`);
    const notices = bundle['third-party-licenses.txt'];
    if (!notices || notices.type !== 'asset') return this.error('Missing public license notices.');
    const build = createHash('sha256').update(JSON.stringify(assets)).update(notices.source).digest('hex').slice(0, 16);
    this.emitFile({ type: 'asset', fileName: 'pwa-assets.json', source: JSON.stringify({ version: 1, build, assets }) });
    const source = readFileSync(fileURLToPath(new URL('./public/sw.js', import.meta.url)), 'utf8').replaceAll('__KRAM_BUILD__', build);
    this.emitFile({ type: 'asset', fileName: 'sw.js', source });
  } } };
}
