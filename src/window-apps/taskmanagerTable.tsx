// Data table primitive for Task Manager 2.0 (Phase 0 stub; C2 in Phase 2 implements it).
import type { ReactElement, ReactNode } from 'react';

export interface DataTableColumn<Row> {
  readonly key: string;
  readonly title: string;
  readonly width?: string;
  readonly align?: 'start' | 'end';
  readonly aggregate?: string;
  readonly heat?: boolean;
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
  readonly emptyMessage?: string;
  readonly loading?: boolean;
  readonly error?: string | null;
  readonly ariaLabel?: string;
}

export function DataTable<Row>(props: DataTableProps<Row>): ReactElement {
  const showEmpty = props.rows.length === 0 && props.error == null && props.loading !== true;
  return (
    <div
      className="kos-tm-table"
      role="grid"
      aria-label={props.ariaLabel}
      data-columns={String(props.columns.length)}
      data-rows={String(props.rows.length)}
      data-tree={props.tree === true ? 'true' : 'false'}
      data-sort={props.sort === undefined ? undefined : `${props.sort.key}:${props.sort.dir}`}
      data-expanded={props.expanded === undefined ? undefined : String(props.expanded.size)}
      data-loading={props.loading === true ? 'true' : 'false'}
    >
      {props.error ?? (showEmpty ? (props.emptyMessage ?? 'No rows') : null)}
    </div>
  );
}
