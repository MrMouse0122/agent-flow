/** 可折叠 JSON 树（默认收起）。输入/输出摘要查看用。 */
import { useState } from 'react';

function Primitive({ value }: { value: unknown }) {
  if (value === null) return <span className="af-json-null">null</span>;
  if (value === undefined) return <span className="af-json-null">undefined</span>;
  if (typeof value === 'string') return <span className="af-json-str">"{value}"</span>;
  if (typeof value === 'number') return <span className="af-json-num">{String(value)}</span>;
  if (typeof value === 'boolean') return <span className="af-json-bool">{String(value)}</span>;
  return <span className="af-json-null">{'{…}'}</span>;
}

function JsonValue({ name, value, depth }: { name?: string; value: unknown; depth: number }) {
  const isObject = value !== null && typeof value === 'object';
  if (!isObject) {
    return (
      <div className="af-json-row">
        {name !== undefined && <span className="af-json-key">{name}: </span>}
        <Primitive value={value} />
      </div>
    );
  }
  return <JsonBranch name={name} value={value} depth={depth} />;
}

function JsonBranch({ name, value, depth }: { name?: string; value: object; depth: number }) {
  const [open, setOpen] = useState(false);
  const isArray = Array.isArray(value);
  const entries = isArray
    ? (value as unknown[]).map((v, i) => [String(i), v] as const)
    : Object.entries(value as Record<string, unknown>);
  const summary = isArray ? `Array(${entries.length})` : `{${entries.length} 键}`;
  return (
    <div className="af-json-branch">
      <button type="button" className="af-json-toggle" onClick={() => setOpen((o) => !o)}>
        <span className={`af-json-chevron ${open ? 'af-json-chevron-open' : ''}`} aria-hidden />
        {name !== undefined && <span className="af-json-key">{name}: </span>}
        <span className="af-json-summary">{open ? (isArray ? `[${entries.length}]` : `{${entries.length}}`) : summary}</span>
      </button>
      {open && (
        <div className="af-json-children">
          {entries.length === 0 && <div className="af-json-row af-json-null">（空）</div>}
          {entries.map(([k, v]) => (
            <JsonValue key={k} name={k} value={v} depth={depth + 1} />
          ))}
        </div>
      )}
    </div>
  );
}

export default function JsonTree({ value }: { value: unknown }) {
  if (value === null || value === undefined) {
    return <div className="af-json-empty">（无数据）</div>;
  }
  return (
    <div className="af-json-tree">
      <JsonValue value={value} depth={0} />
    </div>
  );
}
