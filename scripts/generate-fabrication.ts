import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PACKAGE_KEYS, PACKAGE_LIST, buildCanonicalPackage } from '../src/fabrication/packages.js';
import { analysePackage } from '../src/fabrication/package.js';
import type { FabricationPackage } from '../src/fabrication/types.js';

/**
 * Fabricate the four canonical design-observation packages and write them to
 * data/fabrication as real, self-contained JSON files.
 *
 *   npm run gen:fabrication
 *
 * Every package embeds: measurement observations (with reliability labels), the
 * fit recipe, the independent checking fixture, the truth surface and its grid,
 * and the provenance/parameters used to make it. A manifest records the
 * verification numbers so a reader can see each package's declared conventions
 * were checked, not asserted.
 */

const OUT = resolve(dirname(fileURLToPath(import.meta.url)), '../data/fabrication');
mkdirSync(OUT, { recursive: true });

const mm = (x: number): string => (x * 1000).toFixed(3);

interface ManifestEntry {
  key: string;
  id: string;
  title: string;
  file: string;
  method: string;
  table: string;
  observations: number;
  controlPoints: number;
  fitRms: number;
  fitRmsHoldout: number;
  matingCoverage: number;
  maxGap: number;
  segments: { label: string; coverage: number }[];
  edgeAdvice: string;
  lostFeatures: number;
  outliers: { injected: number; downweighted: number };
  conventionsOk: boolean;
  checks: { id: string; ok: boolean }[];
}

const manifest: { generatedAt: string; packages: ManifestEntry[] } = {
  generatedAt: new Date().toISOString(),
  packages: [],
};

for (const key of PACKAGE_KEYS) {
  const pkg: FabricationPackage = buildCanonicalPackage(key);
  const { analysis, conventions } = analysePackage(pkg);
  const file = resolve(OUT, publicName(key) + '.json');
  writeFileSync(file, JSON.stringify(pkg), 'utf8');

  const entry: ManifestEntry = {
    key,
    id: pkg.id,
    title: pkg.title,
    file: 'data/fabrication/' + publicName(key) + '.json',
    method: pkg.provenance.method,
    table: pkg.provenance.samplingTable,
    observations: pkg.observations.length,
    controlPoints: analysis.controlPointCount,
    fitRms: analysis.fitRms,
    fitRmsHoldout: analysis.fitRmsHoldout,
    matingCoverage: analysis.mating.coverage,
    maxGap: analysis.mating.maxGap,
    segments: analysis.mating.segments.map((s) => ({ label: s.label, coverage: s.coverage })),
    edgeAdvice: analysis.edgeAdvice.advice,
    lostFeatures: analysis.lostFeatures.length,
    outliers: { injected: analysis.outliers.injected, downweighted: analysis.outliers.downweighted },
    conventionsOk: conventions.ok,
    checks: conventions.checks.map((c) => ({ id: c.id, ok: c.ok })),
  };
  manifest.packages.push(entry);

  const seg = analysis.mating.segments.map((s) => `${s.label} ${(s.coverage * 100).toFixed(0)}%`).join(' / ');
  console.log(
    (pkg.provenance.method + '+' + pkg.provenance.samplingTable).padEnd(18) +
      `观测 ${String(pkg.observations.length).padStart(4)} · ` +
      `拟合RMS ${mm(analysis.fitRms)} mm · ` +
      `扣合 ${(analysis.mating.coverage * 100).toFixed(0)}%（${seg}）· ` +
      `最大间隙 ${mm(analysis.mating.maxGap)} mm · ` +
      `建议 ${analysis.edgeAdvice.advice} · ` +
      `约定 ${conventions.ok ? '通过' : '失败'}`,
  );
  if (!conventions.ok) {
    for (const c of conventions.checks.filter((c) => !c.ok)) console.log('    ✗ ' + c.label + ' — ' + c.detail);
  }
}

writeFileSync(resolve(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');

console.log('\n已写入 ' + PACKAGE_KEYS.length + ' 个资料包 → data/fabrication/');
console.log('清单：data/fabrication/manifest.json');
console.log('\n可用包：');
for (const p of PACKAGE_LIST) console.log(`  ${p.key.padEnd(18)} ${p.id}  — ${p.description}`);

/** Filesystem-safe name derived from the registry key, so the path a script or
 *  the UI loads is the same string the registry exposes. */
function publicName(key: string): string {
  return key;
}
