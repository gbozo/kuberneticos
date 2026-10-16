// Data table primitive for Task Manager 2.0
import type { ReactElement, ReactNode } from 'react';
import './taskmanagerTable.css';

export interface DataTableColumn<Row> {
  readonly key: string;
  readonly title: string;
  readonly width?: string;
  readonly align?: 'start' | 'end';
  readonly aggregate?: string;
  readonly heat?: boolean;
  /** Normalised 0–100 value driving the heat tint; falls back to the numeric `key` value. */
  readonly heatValue?: (row: Row) => number | null;
  readonly render?: (row: Row) => ReactNode;
}

export interface DataTableSort {
  readonly key: string;
  readonly dir: 'asc' | 'desc';
}

export interface DataTableProps<Row> {
  readonly columns: readonly DataTableColumn<Row>[];
  readonly rows: readonly Row[];
  readonly rowKey: (row: Row) => string;
  readonly sort?: DataTableSort;
  readonly onSort?: (key: string) => void;
  readonly tree?: boolean;
  readonly depth?: (row: Row) => number;
  readonly expanded?: ReadonlySet<string>;
  readonly onToggle?: (row: Row) => void;
  readonly onActivate?: (row: Row) => void;
  readonly activeKey?: string;
  readonly emptyMessage?: string;
  readonly loading?: boolean;
  readonly error?: string | null;
  readonly ariaLabel?: string;
}

function getRowValue<Row>(row: Row, key: string): unknown {
  const r = row as Record<string, unknown>;
  return r[key];
}

function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function toNumber(value: unknown): number | null {
  if (isNumber(value)) return value;
  if (typeof value === 'string') {
    const n = Number.parseFloat(value);
    if (!Number.isNaN(n)) return n;
  }
  return null;
}

export function DataTable<Row>(props: DataTableProps<Row>): ReactElement {
  const {
    columns,
    rows,
    rowKey,
    sort,
    onSort,
    tree,
    depth,
    expanded,
    onToggle,
    onActivate,
    activeKey,
    emptyMessage = 'No rows',
    loading,
    error,
    ariaLabel,
  } = props;

  const showEmpty = rows.length === 0 && error == null && loading !== true;
  const expandedSet = expanded ?? new Set<string>();

  const visibleRows: { readonly row: Row; readonly level: number }[] = [];
  const collectVisible = (list: readonly Row[], level: number): void => {
    for (const row of list) {
      visibleRows.push({ row, level });
      if (tree === true && expandedSet.has(rowKey(row))) {
        const children = (row as { children?: readonly Row[] }).children;
        if (Array.isArray(children)) {
          collectVisible(children, level + 1);
        }
      }
    }
  };
  collectVisible(rows, 0);

  const handleSort = (key: string): void => {
    if (onSort) {
      onSort(key);
    }
  };

  const handleToggle = (row: Row): void => {
    if (onToggle) {
      onToggle(row);
    }
  };

  const handleActivate = (row: Row): void => {
    if (onActivate) onActivate(row);
  };

  return (
    <div
      className="kos-tm-table"
      role="grid"
      aria-label={ariaLabel}
      data-columns={String(columns.length)}
      data-rows={String(rows.length)}
      data-tree={tree === true ? 'true' : 'false'}
      data-sort={sort === undefined ? undefined : `${sort.key}:${sort.dir}`}
      data-expanded={String(expandedSet.size)}
      data-loading={loading === true ? 'true' : 'false'}
    >
      <div className="kos-tm-table__scroll">
        <table className="kos-tm-table__table" role="table">
          <thead className="kos-tm-table__thead">
            <tr className="kos-tm-table__header-row" role="row">
              {columns.map((col) => {
                const isSorted = sort?.key === col.key;
                const dir = isSorted ? sort?.dir : undefined;
                const canSort = onSort !== undefined;
                return (
                  <th
                    key={col.key}
                    className="kos-tm-table__th"
                    role="columnheader"
                    aria-sort={isSorted ? (dir === 'asc' ? 'ascending' : 'descending') : 'none'}
                    style={{ width: col.width, textAlign: col.align }}
                    data-key={col.key}
                    data-sortable={canSort ? 'true' : 'false'}
                    onClick={canSort ? () => handleSort(col.key) : undefined}
                    tabIndex={canSort ? 0 : -1}
                    onKeyDown={
                      canSort
                        ? (e) => {
                            if (e.key === 'Enter' || e.key === ' ') {
                              e.preventDefault();
                              handleSort(col.key);
                            }
                          }
                        : undefined
                    }
                  >
                    <div className="kos-tm-table__th-content">
                      <span className="kos-tm-table__th-title">{col.title}</span>
                      {col.aggregate !== undefined && (
                        <span className="kos-tm-table__th-aggregate">{col.aggregate}</span>
                      )}
                      {canSort && (
                        <span
                          className="kos-tm-table__th-sort"
                          aria-hidden="true"
                          data-dir={isSorted ? dir : undefined}
                        >
                          {isSorted ? (dir === 'asc' ? '▲' : '▼') : '▲'}
                        </span>
                      )}
                    </div>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody className="kos-tm-table__tbody">
            {loading === true && (
              <tr className="kos-tm-table__row kos-tm-table__row--loading" role="row">
                <td
                  className="kos-tm-table__cell kos-tm-table__cell--state"
                  role="cell"
                  colSpan={columns.length}
                >
                  Loading...
                </td>
              </tr>
            )}
            {error != null && loading !== true && (
              <tr className="kos-tm-table__row kos-tm-table__row--error" role="row">
                <td
                  className="kos-tm-table__cell kos-tm-table__cell--state kos-tm-table__cell--error"
                  role="cell"
                  colSpan={columns.length}
                >
                  {error}
                </td>
              </tr>
            )}
            {showEmpty && (
              <tr className="kos-tm-table__row kos-tm-table__row--empty" role="row">
                <td
                  className="kos-tm-table__cell kos-tm-table__cell--state"
                  role="cell"
                  colSpan={columns.length}
                >
                  {emptyMessage}
                </td>
              </tr>
            )}
            {visibleRows.map(({ row, level }) => {
              const key = rowKey(row);
              const rowDepth = depth ? depth(row) : level;
              const isExpanded = expandedSet.has(key);
              const children = (row as { children?: readonly Row[] }).children;
              const hasChildren = tree === true && Array.isArray(children) && children.length > 0;
              const canToggle = hasChildren && onToggle !== undefined;
              const isRowActive = activeKey !== undefined && activeKey === key;

              return (
                <tr
                  key={key}
                  className={isRowActive ? 'kos-tm-table__row is-active' : 'kos-tm-table__row'}
                  role="row"
                  data-key={key}
                  data-depth={String(rowDepth)}
                  data-expanded={isExpanded ? 'true' : 'false'}
                  data-active={isRowActive ? 'true' : 'false'}
                  onDoubleClick={() => handleActivate(row)}
                  onKeyDown={
                    onActivate !== undefined
                      ? (event) => {
                          if (event.key === 'Enter') {
                            event.preventDefault();
                            handleActivate(row);
                          }
                        }
                      : undefined
                  }
                  aria-selected={isRowActive ? 'true' : 'false'}
                  tabIndex={0}
                >
                  {columns.map((col, idx) => {
                    const raw = getRowValue(row, col.key);
                    const rendered = col.render ? col.render(row) : (raw as ReactNode);
                    const heatRaw = col.heatValue !== undefined ? col.heatValue(row) : raw;
                    const num = toNumber(heatRaw);
                    const heatValue = col.heat === true && num !== null ? num : null;
                    const heatStyle: Record<string, string> | undefined =
                      heatValue !== null
                        ? {
                            '--kos-tm-heat-opacity': String(
                              Math.max(0.08, Math.min(0.6, heatValue / 100)),
                            ),
                          }
                        : undefined;

                    return (
                      <td
                        key={col.key}
                        className={`kos-tm-table__cell ${col.heat === true ? 'kos-tm-table__cell--heat' : ''}`}
                        role="cell"
                        style={{
                          textAlign: col.align,
                          ...(heatStyle ?? {}),
                        }}
                        data-key={col.key}
                        data-heat={col.heat === true ? 'true' : 'false'}
                        data-heat-value={heatValue !== null ? String(heatValue) : undefined}
                      >
                        <div className="kos-tm-table__cell-content">
                          {idx === 0 && tree === true && (
                            <span
                              className="kos-tm-table__tree-indent"
                              style={{ width: `${rowDepth * 16}px` }}
                              aria-hidden="true"
                            />
                          )}
                          {idx === 0 && canToggle && (
                            <button
                              type="button"
                              className="kos-tm-table__tree-toggle"
                              aria-label={isExpanded ? 'Collapse' : 'Expand'}
                              aria-expanded={isExpanded ? 'true' : 'false'}
                              onClick={(e) => {
                                e.stopPropagation();
                                handleToggle(row);
                              }}
                            >
                              <span aria-hidden="true">{isExpanded ? '▾' : '▸'}</span>
                            </button>
                          )}
                          <span className="kos-tm-table__cell-value">{rendered}</span>
                        </div>
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
