import { useMemo, useState } from 'react';
import { scenarioList, buildSession } from '../scenarios/session.js';
import { scenarioById } from '../scenarios/scenarios.js';
import { exportToObj } from '../core/readiness.js';
import { describeHypothesis } from '../core/readiness.js';
import type { WorkbenchSession } from '../scenarios/session.js';
import { SurfaceView } from './three/SurfaceView.js';
import { buildViewerMesh, exportSurface, initialEditable, inspectLocal, refit } from './workbench.js';
import type { EditableSettings } from './workbench.js';
import { ModeTabs } from './ModeTabs.js';
import type { WorkbenchMode } from './ModeTabs.js';
import { FabricationWorkbench } from './FabricationWorkbench.js';

const STATES: Record<string, string> = {
  'blocked-labels': '阻断：标签缺陷',
  'blocked-missing-repeat': '阻断：待确认区未关闭',
  'blocked-unresolved-hypothesis': '阻断：漂移/折线未裁决',
  'blocked-template-failure': '阻断：未过虚拟样板',
  'blocked-diagnostic': '阻断：诊断不通过',
  'ready-for-review': '可发布：待人工审阅',
  released: '已发布',
};

function download(name: string, text: string): void {
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

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

export function App() {
  const [mode, setMode] = useState<WorkbenchMode>('scenario');
  return (
    <div className="app">
      <header>
        <div>
          <h1>{mode === 'scenario' ? '测点曲面拟合工作台' : '设计观测制作 · 曲面测点资料包'}</h1>
          <p className="subtitle">
            {mode === 'scenario'
              ? '翼尖样件 · 参数标签由输入提供并校验 · 漂移/折线假设由样板试配与对侧复测裁决'
              : '自制带参数标签与可靠度的测点 · 保存真值与观测生成脚本 · 分离拟合者与装配者角色'}
          </p>
        </div>
        <ModeTabs mode={mode} onChange={setMode} />
      </header>
      {mode === 'scenario' ? <ScenarioWorkbench /> : <FabricationWorkbench />}
    </div>
  );
}

function ScenarioWorkbench() {
  const specs = scenarioList();
  const [scenarioId, setScenarioId] = useState(specs[0].id);
  const [editable, setEditable] = useState<EditableSettings | null>(null);
  const [marker, setMarker] = useState<{ u: number; v: number } | null>(null);

  const session = useMemo<WorkbenchSession>(() => buildSession(scenarioById(scenarioId)!), [scenarioId]);
  const currentEditable = editable ?? initialEditable(session);

  const result = useMemo(() => refit(session, currentEditable), [session, currentEditable]);
  const mesh = useMemo(() => buildViewerMesh(result.fit.lattice, result.fit.residuals, 57, 57), [result.fit]);

  const inspect = marker
    ? inspectLocal(result.fit, marker.u, marker.v)
    : inspectLocal(result.fit, 0.5, 0.62);

  const points = useMemo(() => {
    const byId = new Map(result.fit.observations.map((o) => [o.id, o.point]));
    return result.fit.residuals
      .map((r) => ({ position: byId.get(r.id), distance: r.distance, weight: r.weight }))
      .filter((p): p is { position: [number, number, number]; distance: number; weight: number } => !!p.position);
  }, [result.fit]);

  const setE = (patch: Partial<EditableSettings>) => setEditable({ ...currentEditable, ...patch });
  const pending = result.readiness.pendingRegion;

  return (
    <>
      <div className="subheader">
        <div className="scenario-picker">
          <label>
            场景
            <select
              value={scenarioId}
              onChange={(e) => {
                setScenarioId(e.target.value);
                setEditable(null);
                setMarker(null);
              }}
            >
              {specs.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.id} — {s.title}
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>

      <div className="layout">
        <aside className="left">
          <section className="card">
            <h2>裁决</h2>
            <div className={'verdict verdict-' + session.arbitration.hypothesis}>
              {describeHypothesis(session.arbitration.hypothesis)}
            </div>
            <p className="expected">预期结果：{session.bundle.spec.expected.outcome}</p>
            <ul className="rationale">
              {session.arbitration.score.rationale.map((r, i) => (
                <li key={i}>{r}</li>
              ))}
            </ul>
          </section>

          <section className="card">
            <h2>发布门</h2>
            <div className={'gate gate-' + result.readiness.state}>{STATES[result.readiness.state] ?? result.readiness.state}</div>
            <ul className="checks">
              {result.readiness.checks.map((c) => (
                <li key={c.id} className={c.ok ? 'ok' : 'fail'}>
                  <span className="dot" /> {c.label}
                  <small>{c.detail}</small>
                </li>
              ))}
            </ul>
            {pending && (
              <div className="pending">
                <strong>待确认区</strong>
                <span>v ∈ [{pending.vRange[0].toFixed(2)}, {pending.vRange[1].toFixed(2)}]</span>
                <p>{pending.reason}</p>
                <p className="warn">工作台不擅自输出可加工面：可编辑曲面可导出，可加工面被锁。</p>
              </div>
            )}
            <div className="export-row">
              <button onClick={() => download(scenarioId + '-editable.obj', exportToObj(exportSurface(result.fit, result.readiness)))}>
                导出可编辑曲面 (OBJ)
              </button>
              <button
                className={result.readiness.canExportMachinable ? 'primary' : 'disabled'}
                disabled={!result.readiness.canExportMachinable}
                title={result.readiness.canExportMachinable ? '' : '门未通过，可加工面被锁定'}
                onClick={() => download(scenarioId + '-machinable.obj', exportToObj(exportSurface(result.fit, result.readiness)))}
              >
                导出可加工面 (OBJ)
              </button>
            </div>
          </section>

          <section className="card">
            <h2>标签校验</h2>
            <p>
              共 {session.validation.checked} 条，接受 {session.validation.accepted.length} 条，隔离 {session.validation.rejected.length} 条
            </p>
            <p className="hint">缺失/重复标签被隔离，未补齐、未任意去重。</p>
          </section>
        </aside>

        <main className="center">
          <SurfaceView
            mesh={mesh}
            points={points}
            pendingBand={pending ? { vMin: pending.vRange[0], vMax: pending.vRange[1] } : null}
            marker={marker}
            uRange={[result.fit.lattice.uMin, result.fit.lattice.uMax]}
            vRange={[result.fit.lattice.vMin, result.fit.lattice.vMax]}
            onPick={(p) => setMarker(p)}
          />
          <div className="viewport-caption">
            点击曲面查看局部残差 · 拖动旋转 · 颜色按残差着色（蓝→红）· 橙色带为待确认区
          </div>
        </main>

        <aside className="right">
          <section className="card">
            <h2>拟合设置</h2>
            <Slider label="u 向控制点" value={currentEditable.countU} min={5} max={14} step={1} format={(x) => String(x)} onChange={(x) => setE({ countU: x })} />
            <Slider label="v 向控制点" value={currentEditable.countV} min={5} max={16} step={1} format={(x) => String(x)} onChange={(x) => setE({ countV: x })} />
            <Slider label="张力权重 u" value={currentEditable.tensionU} min={0} max={0.05} step={0.001} onChange={(x) => setE({ tensionU: x })} />
            <Slider label="张力权重 v" value={currentEditable.tensionV} min={0} max={0.05} step={0.001} onChange={(x) => setE({ tensionV: x })} />
            <Slider label="混合曲率权重 u" value={currentEditable.blendU} min={0} max={0.02} step={0.0005} onChange={(x) => setE({ blendU: x })} />
            <Slider label="混合曲率权重 v" value={currentEditable.blendV} min={0} max={0.02} step={0.0005} onChange={(x) => setE({ blendV: x })} />
            <Slider label="平滑先验" value={currentEditable.prior} min={0} max={0.004} step={0.0001} onChange={(x) => setE({ prior: x })} />
            <Slider label="法向约束权重" value={currentEditable.normalWeight} min={0} max={1} step={0.05} onChange={(x) => setE({ normalWeight: x })} />
            <label className="select-row">
              稳健加权
              <select value={currentEditable.robust} onChange={(e) => setE({ robust: e.target.value as EditableSettings['robust'] })}>
                <option value="huber">Huber（单调，推荐）</option>
                <option value="tukey">Tukey（重降权）</option>
                <option value="none">关闭</option>
              </select>
            </label>
            <label className="check-row">
              <input
                type="checkbox"
                checked={currentEditable.crease.enabled}
                onChange={(e) => setE({ crease: { ...currentEditable.crease, enabled: e.target.checked } })}
              />
              保留设计折线（C0）
            </label>
            {currentEditable.crease.enabled && (
              <Slider label="折线位置 v" value={currentEditable.crease.at} min={0.1} max={0.9} step={0.005} onChange={(x) => setE({ crease: { ...currentEditable.crease, at: x } })} />
            )}
            {result.error && <p className="error">拟合失败：{result.error}</p>}
          </section>

          <section className="card">
            <h2>局部残差</h2>
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
                    <td>{(o.distance * 1000).toFixed(3)}</td>
                    <td>{(o.signed * 1000).toFixed(3)}</td>
                    <td>{o.weight.toFixed(3)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          <section className="card">
            <h2>复杂度 / 形态代价</h2>
            <dl className="metrics">
              <dt>控制点</dt>
              <dd>{result.fit.lattice.countU * result.fit.lattice.countV}</dd>
              <dt>观测/自由点</dt>
              <dd>{result.fit.diagnostics.dataPerUnknown.toFixed(2)}</dd>
              <dt>残差 RMS</dt>
              <dd>{(result.fit.rms * 1000).toFixed(3)} mm</dd>
              <dt>留出 RMS</dt>
              <dd>{(result.fit.rmsHoldout * 1000).toFixed(3)} mm</dd>
              <dt>最大曲率</dt>
              <dd>{result.fit.fairness.maxCurvature.toFixed(2)}</dd>
              <dt>混合能</dt>
              <dd>{result.fit.fairness.blend.toExponential(2)}</dd>
              <dt>样板失败点</dt>
              <dd>{result.template.failures}</dd>
            </dl>
            {session.arbitration.overfitComparison && (
              <div className="overfit">
                <strong>过拟合比较：{session.arbitration.overfitComparison.verdict}</strong>
                <p>{session.arbitration.overfitComparison.explanation}</p>
              </div>
            )}
          </section>

          <section className="card">
            <h2>权重规则</h2>
            <ul className="weights">
              {Object.entries(result.fit.probeFactors).map(([p, f]) => (
                <li key={p}>
                  <span className="mono">{p}</span> × {f.toFixed(3)}
                </li>
              ))}
              {Object.entries(currentEditable.probeWeights).map(([p, w]) => (
                <li key={'manual-' + p}>
                  <span className="mono">{p}（人工）</span> × {w.toFixed(3)}
                </li>
              ))}
            </ul>
          </section>
        </aside>
      </div>
    </>
  );
}
