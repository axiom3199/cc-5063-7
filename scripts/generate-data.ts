import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SCENARIOS, generateScenario } from '../src/scenarios/scenarios.js';
import { fileToCsv } from '../src/scenarios/measurementFile.js';

/**
 * Write the six scenario measurement files to data/wingtip as CSV + JSON, so the
 * workbench can be driven from files rather than only from generated in-memory
 * bundles. `npm run gen:data`.
 */

const OUT = resolve(dirname(fileURLToPath(import.meta.url)), '../data/wingtip');
mkdirSync(OUT, { recursive: true });

for (const spec of SCENARIOS) {
  const bundle = generateScenario(spec);
  const base = resolve(OUT, spec.id);
  writeFileSync(base + '.csv', fileToCsv(bundle.file), 'utf8');
  writeFileSync(base + '.json', JSON.stringify(bundle.file, null, 2), 'utf8');
  const bad = bundle.file.records.filter((r) => !r.params).length;
  console.log(
    spec.id.padEnd(26) +
      bundle.file.records.length + ' 条记录，' +
      bundle.file.records.filter((r) => r.probeId === 'probe-A').length + ' 条上表面主测，' +
      bundle.file.records.filter((r) => r.probeId === 'probe-B').length + ' 条第二探头，' +
      bad + ' 条缺标签' +
      ' → data/wingtip/' + spec.id + '.{csv,json}',
  );
}
console.log('\n已生成 ' + SCENARIOS.length + ' 个测点文件。');
