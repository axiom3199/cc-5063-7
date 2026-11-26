import { useMemo, useState } from 'react';
import { analysePackage } from '../fabrication/package.js';
import { loadPersistedPackages } from '../fabrication/loader.js';
import { ridgeBandHalfWidth } from '../fabrication/truthSurface.js';
import type { FabricationPackage, FitRecipe } from '../fabrication/types.js';
import type { FitResult } from '../core/types.js';
import { SurfaceView } from './three/SurfaceView.js';
import { buildViewerMesh, inspectLocal } from './workbench.js';

const PACKAGES = loadPersistedPackages();

const mm = (x: number): string => (x * 1000).toFixed(3);

const ADVICE_LABEL: Record<string, string> = {
  none: '无需补测',
  'add-measurement': '补测该段棱边',
  'method-review': '复核成型/标定方法',
};

function Slider(props: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  format?: (x: number) => string;
  onChange: (x: number) => void;
}) {
  return (
    <label className="slider">
      <span>
        {props.label}
        <em>{props.format ? props.format(props.value) : props.value.toFixed(3)}</em>
      </span>
      <input type="range" min={props.min} max={props.max} step={props.step} value={props.value} onChange={(e) => props.onChange(Number(e.target.value))} />
    </label>
  );
}

interface RunState {
  pkg: FabricationPackage;
  fit: FitResult;
  analysis: ReturnType<typeof analysePackage>['analysis'];
  conventions: ReturnType<typeof analysePackage>['conventions'];
  recipe: FitRecipe;
}

export function FabricationWorkbench() {
  const [file, setFile] = useState(PACKAGES[0]?.file ?? '');
  const [recipeEdit, setRecipeEdit] = useState<FitRecipe | null>(null);
  const [marker, setMarker] = useState<{ u: number; v: number } | null>(null);

  const selected = PACKAGES.find((p) => p.file === file) ?? PACKAGES[0];
  const recipe = recipeEdit ?? selected?.pkg.recipe ?? null;

  // fit once per (package, recipe); a failed refit keeps the previous view and
  // reports the error, instead of blanking the surface.
  const outcome = useMemo<{ run: RunState | null; error: string | null }>(() => {
    if (!selected || !recipe) return { run: null, error: '没有可加载的资料包' };
    try {
      const pkg: FabricationPackage = { ...selected.pkg, recipe };
      const result = analysePackage(pkg);
      return { run: { pkg, ...result, recipe }, error: null };
    } catch (err) {
      return { run: null, error: (err as Error).message };
    }
  }, [selected, recipe]);
  const run = outcome.run;
  const lastError = outcome.error;

  const band = selected ? ridgeBandHalfWidth(selected.pkg.truth.spec) : 0.06;

  const mesh = useMemo(() => (run ? buildViewerMesh(run.fit.lattice, run.fit.residuals, 61, 61) : null), [run]);

  const points = useMemo(() => {
    if (!run) return [];
    const byId = new Map(run.fit.observations.map((o) => [o.id, o.point]));
    return run.fit.residuals
      .map((r) => ({ position: byId.get(r.id), distance: r.distance, weight: r.weight }))
      .filter((p): p is { position: [number, number, number]; distance: number; weight: number } => !!p.position);
  }, [run]);

  if (!PACKAGES.length) {
    return (
      <div className="empty-state">
        未找到已入库的资料包。请先运行 <code>npm run gen:fabrication</code> 生成 <code>data/fabrication/*.json</code>。
      </div>
    );
  }

  const setR = (patch: Partial<FitRecipe>) => {
    if (!recipe) return;
    setRecipeEdit({ ...recipe, ...patch });
  };

  const inspect = run ? inspectLocal(run.fit, marker?.u ?? 0.5, marker?.v ?? selected!.pkg.truth.spec.ridgeV) : null;
  const spec = selected!.pkg.truth.spec;

  return (
    <div className="layout">
      <aside className="left">
        <section className="card">
          <h2>资料包</h2>
          <select
            className="package-select"
            value={file}
            onChange={(e) => {
              setFile(e.target.value);
              setRecipeEdit(null);
              setMarker(null);
            }}
          >
            {PACKAGES.map((p) => (
              <option key={p.file} value={p.file}>
                {p.pkg.title}
              </option>
            ))}
          </select>
          <dl className="metrics" style={{ marginTop: 10 }}>
            <dt>成型方法</dt>
            <dd>{run ? (run.pkg.provenance.method === 'analytic' ? '解析真值' : '标定截面拼装') : '—'}</dd>
            <dt>采样表</dt>
            <dd>{run ? run.pkg.plan.label : '—'}</dd>
            <dt>观测数</dt>
            <dd>{run ? run.analysis.observationCount : '—'}</dd>
            <dt>控制点</dt>
            <dd>{run ? run.analysis.controlPointCount : '—'}</dd>
            <dt>种子 / 噪声</dt>
            <dd>{run ? `${run.pkg.provenance.seed} / ${mm(run.pkg.provenance.noiseSigma)} mm` : '—'}</dd>
            <dt>离群注入</dt>
            <dd>{run ? run.pkg.provenance.outlierCount : '—'}</dd>
          </dl>
        </section>

        <section className="card">
          <h2>约定检查</h2>
          {run ? (
            <>
              <div className={'gate ' + (run.conventions.ok ? 'gate-pass' : 'gate-fail')}>
                {run.conventions.ok ? '通过：重建结果符合声明' : '未通过：重建偏离声明'}
              </div>
              <ul className="checks">
                {run.conventions.checks.map((c) => (
                  <li key={c.id} className={c.ok ? 'ok' : 'fail'}>
                    <span className="dot" /> {c.label}
                    <small>{c.detail}</small>
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <p className="hint">选择资料包后显示。</p>
          )}
        </section>

        <section className="card">
          <h2>棱边补测建议</h2>
          {run ? (
            <div className={'advice advice-' + run.analysis.edgeAdvice.advice}>
              <strong>{ADVICE_LABEL[run.analysis.edgeAdvice.advice]}</strong>
              <p>{run.analysis.edgeAdvice.detail}</p>
            </div>
          ) : (
            <p className="hint">—</p>
          )}
          {run && (
            <dl className="metrics" style={{ marginTop: 10 }}>
              <dt>整体扣合率</dt>
              <dd>{(run.analysis.mating.coverage * 100).toFixed(0)}%</dd>
              <dt>最大间隙</dt>
              <dd>{mm(run.analysis.mating.maxGap)} mm</dd>
              <dt>参数域覆盖</dt>
              <dd>{(run.analysis.coverage.occupancy * 100).toFixed(0)}%</dd>
            </dl>
          )}
        </section>
      </aside>

      <main className="center">
        {mesh ? (
          <>
            <SurfaceView
              mesh={mesh}
              points={points}
              pendingBand={{ vMin: spec.ridgeV - band, vMax: spec.ridgeV + band }}
              marker={marker}
              uRange={[run!.fit.lattice.uMin, run!.fit.lattice.uMax]}
              vRange={[run!.fit.lattice.vMin, run!.fit.lattice.vMax]}
              onPick={(p) => setMarker(p)}
            />
            <div className="viewport-caption">
              拟合曲面按测点到面距离着色（蓝近→红远）· 橙色带为尖棱监测带 v≈{spec.ridgeV.toFixed(2)} · 点击查看局部残差 · 拖动旋转
            </div>
          </>
        ) : (
          <div className="empty-state">
            拟合失败：{lastError ?? '未知错误'}
          </div>
        )}
        {lastError && mesh && <div className="refit-error">当前设置拟合失败：{lastError}</div>}
      </main>

      <aside className="right">
        <section className="card">
          <h2>拟合核控件（驱动重建）</h2>
          <p className="hint">修改即调用测点拟合核重新求解，并回灌下方约定检查。</p>
          {recipe && (
            <>
              <Slider label="u 向控制点" value={recipe.countU} min={5} max={14} step={1} format={(x) => String(x)} onChange={(x) => setR({ countU: x })} />
              <Slider label="v 向控制点" value={recipe.countV} min={5} max={16} step={1} format={(x) => String(x)} onChange={(x) => setR({ countV: x })} />
              <Slider label="张力权重" value={recipe.tensionWeight} min={0} max={0.05} step={0.001} onChange={(x) => setR({ tensionWeight: x })} />
              <Slider label="混合曲率权重" value={recipe.blendWeight} min={0} max={0.02} step={0.0005} onChange={(x) => setR({ blendWeight: x })} />
              <Slider label="平滑先验" value={recipe.priorWeight} min={0} max={0.004} step={0.0001} onChange={(x) => setR({ priorWeight: x })} />
              <label className="select-row">
                稳健加权
                <select value={recipe.robust} onChange={(e) => setR({ robust: e.target.value as FitRecipe['robust'] })}>
                  <option value="huber">Huber（单调，推荐）</option>
                  <option value="tukey">Tukey（重降权）</option>
                  <option value="none">关闭</option>
                </select>
              </label>
              <label className="check-row">
                <input
                  type="checkbox"
                  checked={recipe.crease !== null}
                  onChange={(e) => setR({ crease: e.target.checked ? { axis: 'v', at: spec.ridgeV } : null })}
                />
                在尖棱站位保留 C0 折线（v≈{spec.ridgeV.toFixed(2)}）
              </label>
              <label className="check-row">
                <input type="checkbox" checked={recipe.useNormals} onChange={(e) => setR({ useNormals: e.target.checked })} />
                使用法向约束
              </label>
            </>
          )}
        </section>

        <section className="card">
          <h2>测点到面距离</h2>
          {run && (
            <dl className="metrics">
              <dt>参与拟合 RMS</dt>
              <dd>{mm(run.analysis.fitRms)} mm</dd>
              <dt>留出 RMS</dt>
              <dd>{mm(run.analysis.fitRmsHoldout)} mm</dd>
              <dt>真值 RMS</dt>
              <dd>{mm(run.analysis.truthError.rms)} mm</dd>
              <dt>尖棱带真值 RMS</dt>
              <dd>{mm(run.analysis.truthError.bandRms)} mm</dd>
              <dt>离群降权</dt>
              <dd>
                {run.analysis.outliers.downweighted}/{run.analysis.outliers.injected}
              </dd>
            </dl>
          )}
        </section>

        <section className="card">
          <h2>装配扣合（仅读曲面+样板）</h2>
          {run && (
            <table>
              <thead>
                <tr>
                  <th>棱边分段</th>
                  <th>扣合率</th>
                  <th>最大间隙 mm</th>
                </tr>
              </thead>
              <tbody>
                {run.analysis.mating.segments.map((s) => (
                  <tr key={s.id}>
                    <td>{s.label}</td>
                    <td>{(s.coverage * 100).toFixed(0)}%</td>
                    <td>{mm(s.maxGap)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>

        <section className="card">
          <h2>丢失特征</h2>
          {run && run.analysis.lostFeatures.length === 0 && <p className="hint">未检出丢失特征。</p>}
          {run && run.analysis.lostFeatures.length > 0 && (
            <ul className="lost">
              {run.analysis.lostFeatures.slice(0, 5).map((f, i) => (
                <li key={i}>
                  <span className="mono">
                    u≈{f.u.toFixed(2)} · {mm(f.magnitude)} mm
                  </span>
                  <small>{f.reason}</small>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="card">
          <h2>局部残差</h2>
          {inspect ? (
            <>
              <p className="hint">
                位置 u={inspect.u.toFixed(3)}, v={inspect.v.toFixed(3)}
              </p>
              <table>
                <thead>
                  <tr>
                    <th>测点</th>
                    <th>距离 mm</th>
                    <th>法向 mm</th>
                    <th>权重</th>
                  </tr>
                </thead>
                <tbody>
                  {inspect.nearestObservations.map((o) => (
                    <tr key={o.id}>
                      <td className="mono">{o.id}</td>
                      <td>{mm(o.distance)}</td>
                      <td>{mm(o.signed)}</td>
                      <td>{o.weight.toFixed(3)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          ) : (
            <p className="hint">点击曲面查看。</p>
          )}
        </section>
      </aside>
    </div>
  );
}
