export type WorkbenchMode = 'scenario' | 'fabrication';

/** Top-level switch between the measurement-point fitting workbench and the
 *  design-observation fabrication (design-observation) workbench. */
export function ModeTabs(props: { mode: WorkbenchMode; onChange: (m: WorkbenchMode) => void }) {
  const tabs: { id: WorkbenchMode; label: string }[] = [
    { id: 'scenario', label: '测点拟合工作台' },
    { id: 'fabrication', label: '设计观测制作' },
  ];
  return (
    <div className="tabs" role="tablist">
      {tabs.map((t) => (
        <button
          key={t.id}
          role="tab"
          aria-selected={props.mode === t.id}
          className={'tab' + (props.mode === t.id ? ' active' : '')}
          onClick={() => props.onChange(t.id)}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}
