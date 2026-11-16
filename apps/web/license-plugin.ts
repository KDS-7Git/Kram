import { readFileSync } from 'node:fs';
import type { Plugin } from 'vite';

/** Font assets are not JavaScript modules, so include their notices explicitly. */
export function fontLicensePlugin(): Plugin {
  return {
    name: 'kram-font-licenses',
    apply: 'build',
    generateBundle: {
      order: 'post',
      handler(_options, bundle) {
        const notices = bundle['third-party-licenses.txt'];
        if (!notices || notices.type !== 'asset') return this.error('Missing bundled dependency license notices.');
        const source = typeof notices.source === 'string' ? notices.source : Buffer.from(notices.source).toString('utf8');
        const fonts = ['Fraunces-OFL.txt', 'Source-Sans-3-OFL.txt'].map(file =>
          `\n## ${file}\n\n${readFileSync(new URL(`../../licenses/fonts/${file}`, import.meta.url), 'utf8')}`,
        );
        notices.source = source + '\n# Bundled font licenses\n' + fonts.join('\n');
      },
    },
  };
}
