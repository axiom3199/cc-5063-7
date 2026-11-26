/** Load persisted fabrication packages in the browser.
 *
 *  Vite statically bundles every JSON under data/fabrication via import.meta.glob,
 *  so the UI can list and open exactly the files that were committed to the repo
 *  (the same files the reconstruction script fits). No fetch, no public/ copy: a
 *  package either exists in the repo or it does not load. */

import { parsePackage } from './package.js';
import type { FabricationPackage } from './types.js';

const modules = import.meta.glob<unknown>('/data/fabrication/*.json', { eager: true, import: 'default' });

export interface LoadedPackage {
  file: string;
  pkg: FabricationPackage;
}

/** All persisted packages except the manifest, keyed by filename stem. */
export function loadPersistedPackages(): LoadedPackage[] {
  const out: LoadedPackage[] = [];
  for (const [path, mod] of Object.entries(modules)) {
    const file = path.split('/').pop() ?? path;
    if (file === 'manifest.json') continue;
    try {
      out.push({ file, pkg: parsePackage(mod) });
    } catch {
      // a malformed file should not take down the picker; skip it silently here
      // and let the reconstruction script report the hard error.
    }
  }
  out.sort((a, b) => a.file.localeCompare(b.file));
  return out;
}
