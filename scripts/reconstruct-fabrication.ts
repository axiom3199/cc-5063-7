import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { analysePackage, parsePackage } from '../src/fabrication/package.js';
import { PACKAGE_KEYS } from '../src/fabrication/packages.js';
import type { FabricationPackage } from '../src/fabrication/types.js';

/**
 * Reconstruct a fabrication package with the measurement-point fit kernel and
 * verify the declared conventions.
 *
 *   npm run reconstruct:fabrication -- [package-path|key] [--allow-fail]
 *
 * The reconstruction is a genuine point fit: the fitter is handed only the
 * observations and recipe. The truth surface is used solely for scoring. Exit
 * code is nonzero when any convention fails, so this doubles as executable
 * evidence in CI (a package cannot silently drift out of its declaration).
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const allowFail = process.argv.includes('--allow-fail');

if (args.length === 0) {
  console.error('用法：npm run reconstruct:fabrication -- <资料包路径 | ' + PACKAGE_KEYS.join(' | ') + '> [--allow-fail]');
  process.exit(2);
}

const target = args[0];
const path = target.endsWith('.json') || target.includes('/') ? resolve(ROOT, target) : resolve(ROOT, 'data/fabrication', target + '.json');

let pkg: FabricationPackage;
try {
  pkg = parsePackage(readFileSync(path, 'utf8'));
} catch (err) {
  console.error(`无法加载资料包 ${path}：${(err as Error).message}`);
  process.exit(2);
}

const { analysis, fit, conventions } = analysePackage(pkg);
const mm = (x: number): string => (x * 1000).toFixed(3);

console.log(`资料包 ${pkg.id} — ${pkg.title}`);
console.log(`  文件          ${path.replace(ROOT + '/', '')}`);
console.log(`  成型方法      ${pkg.provenance.method}${pkg.truth.sectionStations ? `（${pkg.truth.sectionStations.length} 个标定截面）` : ''}`);
console.log(`  采样表        ${pkg.plan.label}（${pkg.observations.length} 条观测）`);
console.log(`  种子/噪声     seed ${pkg.provenance.seed} · σ ${mm(pkg.provenance.noiseSigma)} mm · 离群 ${pkg.provenance.outlierCount}`);
console.log(`  拟合核       ${analysis.controlPointCount} 控制点 · 参与 RMS ${mm(analysis.fitRms)} mm · 留出 RMS ${mm(analysis.fitRmsHoldout)} mm`);
console.log('');
console.log('  装配（仅读取拟合曲面 + 独立样板）：');
console.log(`    整体扣合率  ${(analysis.mating.coverage * 100).toFixed(1)}%  (${analysis.mating.engaged}/${analysis.mating.total})`);
console.log(`    最大间隙    ${mm(analysis.mating.maxGap)} mm · RMS 间隙 ${mm(analysis.mating.rmsGap)} mm`);
for (const s of analysis.mating.segments) {
  console.log(`    棱边 ${s.label.padEnd(18)} 扣合 ${(s.coverage * 100).toFixed(0)}% · 最大间隙 ${mm(s.maxGap)} mm`);
}
console.log(`    最弱棱边建议  ${analysis.edgeAdvice.advice}`);
console.log(`      ${analysis.edgeAdvice.detail}`);
console.log('');
console.log('  校验（真值 + 观测覆盖 + 离群）：');
console.log(`    参数域覆盖  ${(analysis.coverage.occupancy * 100).toFixed(0)}%（尖棱带内 ${analysis.coverage.ridgeBandCount} 点）`);
console.log(`    真值 RMS    ${mm(analysis.truthError.rms)} mm · 尖棱带 ${mm(analysis.truthError.bandRms)} mm · 最大 ${mm(analysis.truthError.max)} mm`);
console.log(`    丢失特征    ${analysis.lostFeatures.length} 处`);
for (const f of analysis.lostFeatures.slice(0, 3)) console.log(`      u≈${f.u.toFixed(2)} 幅值 ${mm(f.magnitude)} mm → ${f.advice}`);
console.log(`    离群       注入 ${analysis.outliers.injected}，降权 ${analysis.outliers.downweighted}（平均稳健权重 ${analysis.outliers.meanRobustWeight.toFixed(3)}）`);
console.log('');
console.log('  约定检查：');
for (const c of conventions.checks) console.log(`    ${c.ok ? '✓' : '✗'} ${c.label} — ${c.detail}`);
console.log('');
console.log(conventions.ok ? '✓ 该资料包的重建结果符合其声明的约定。' : '✗ 该资料包的重建结果不符合声明的约定。');

if (!conventions.ok && !allowFail) process.exit(1);
