import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { DataTable } from './taskmanagerTable';
import type { DataTableColumn, DataTableSort } from './taskmanagerTable';

interface Row {
  readonly name: string;
  readonly cpu?: number;
  readonly depth?: number;
  readonly children?: readonly Row[];
}

function header(container: HTMLElement, key: string): HTMLTableCellElement {
  const el = container.querySelector<HTMLTableCellElement>(`th[data-key="${key}"]`);
  if (el === null) throw new Error(`header not found: ${key}`);
  return el;
}

function bodyRow(container: HTMLElement, key: string): HTMLTableRowElement {
  const el = container.querySelector<HTMLTableRowElement>(`tbody tr[data-key="${key}"]`);
  if (el === null) throw new Error(`row not found: ${key}`);
  return el;
}

function bodyRows(container: HTMLElement): HTMLTableRowElement[] {
  return Array.from(container.querySelectorAll<HTMLTableRowElement>('tbody tr[data-key]'));
}

function bodyCell(container: HTMLElement, rowKey: string, columnKey: string): HTMLTableCellElement {
  const el = container.querySelector<HTMLTableCellElement>(
    `tbody tr[data-key="${rowKey}"] td[data-key="${columnKey}"]`,
  );
  if (el === null) throw new Error(`cell not found: ${rowKey}/${columnKey}`);
  return el;
}

function toggleButton(container: HTMLElement, rowKey: string): HTMLButtonElement {
  const el = container.querySelector<HTMLButtonElement>(`tbody tr[data-key="${rowKey}"] button`);
  if (el === null) throw new Error(`toggle not found: ${rowKey}`);
  return el;
}

function queryToggleButton(container: HTMLElement, rowKey: string): HTMLButtonElement | null {
  return container.querySelector<HTMLButtonElement>(`tbody tr[data-key="${rowKey}"] button`);
}

const NAME_CPU_COLUMNS: readonly DataTableColumn<Row>[] = [
  { key: 'name', title: 'Name' },
  { key: 'cpu', title: 'CPU', aggregate: '42%' },
];

const flatRows: readonly Row[] = [
  { name: 'web', cpu: 5 },
  { name: 'db', cpu: 7 },
];

describe('DataTable sorting', () => {
  it('calls onSort with the column key on header click', () => {
    const onSort = vi.fn<(key: string) => void>();
    const { container } = render(
      <DataTable
        columns={NAME_CPU_COLUMNS}
        rows={flatRows}
        rowKey={(row) => row.name}
        onSort={onSort}
      />,
    );

    fireEvent.click(header(container, 'cpu'));
    expect(onSort).toHaveBeenCalledTimes(1);
    expect(onSort).toHaveBeenCalledWith('cpu');

    fireEvent.click(header(container, 'name'));
    expect(onSort).toHaveBeenLastCalledWith('name');
  });

  it('calls onSort on Enter and Space keydown on a sortable header', () => {
    const onSort = vi.fn<(key: string) => void>();
    const { container } = render(
      <DataTable
        columns={NAME_CPU_COLUMNS}
        rows={flatRows}
        rowKey={(row) => row.name}
        onSort={onSort}
      />,
    );
    const th = header(container, 'cpu');

    fireEvent.keyDown(th, { key: 'Enter' });
    expect(onSort).toHaveBeenLastCalledWith('cpu');

    fireEvent.keyDown(th, { key: ' ' });
    expect(onSort).toHaveBeenLastCalledWith('cpu');
    expect(onSort).toHaveBeenCalledTimes(2);
  });

  it('marks headers unsortable when onSort is absent', () => {
    const { container } = render(
      <DataTable columns={NAME_CPU_COLUMNS} rows={flatRows} rowKey={(row) => row.name} />,
    );
    const th = header(container, 'cpu');

    expect(th.getAttribute('data-sortable')).toBe('false');
    expect(th.tabIndex).toBe(-1);
    expect(th.querySelector('.kos-tm-table__th-sort')).toBeNull();
    fireEvent.click(th);
    fireEvent.keyDown(th, { key: 'Enter' });
  });

  it('renders descending sort state (aria-sort, data-dir, ▼ glyph)', () => {
    const onSort = vi.fn<(key: string) => void>();
    const sort: DataTableSort = { key: 'cpu', dir: 'desc' };
    const { container } = render(
      <DataTable
        columns={NAME_CPU_COLUMNS}
        rows={flatRows}
        rowKey={(row) => row.name}
        sort={sort}
        onSort={onSort}
      />,
    );

    const th = header(container, 'cpu');
    expect(th.getAttribute('aria-sort')).toBe('descending');
    const indicator = th.querySelector('.kos-tm-table__th-sort');
    expect(indicator).not.toBeNull();
    expect(indicator?.getAttribute('data-dir')).toBe('desc');
    expect(indicator?.textContent).toBe('▼');

    const nameTh = header(container, 'name');
    expect(nameTh.getAttribute('aria-sort')).toBe('none');
    const nameIndicator = nameTh.querySelector('.kos-tm-table__th-sort');
    expect(nameIndicator).not.toBeNull();
    expect(nameIndicator?.getAttribute('data-dir')).toBeNull();
  });

  it('renders ascending sort state with the ▲ glyph', () => {
    const onSort = vi.fn<(key: string) => void>();
    const sort: DataTableSort = { key: 'name', dir: 'asc' };
    const { container } = render(
      <DataTable
        columns={NAME_CPU_COLUMNS}
        rows={flatRows}
        rowKey={(row) => row.name}
        sort={sort}
        onSort={onSort}
      />,
    );

    const th = header(container, 'name');
    expect(th.getAttribute('aria-sort')).toBe('ascending');
    const indicator = th.querySelector('.kos-tm-table__th-sort');
    expect(indicator?.getAttribute('data-dir')).toBe('asc');
    expect(indicator?.textContent).toBe('▲');
  });

  it('renders the column aggregate inside the header', () => {
    const onSort = vi.fn<(key: string) => void>();
    const { container } = render(
      <DataTable
        columns={NAME_CPU_COLUMNS}
        rows={flatRows}
        rowKey={(row) => row.name}
        onSort={onSort}
      />,
    );

    const aggregate = header(container, 'cpu').querySelector('.kos-tm-table__th-aggregate');
    expect(aggregate?.textContent).toBe('42%');
    expect(header(container, 'name').querySelector('.kos-tm-table__th-aggregate')).toBeNull();
  });
});

describe('DataTable tree flattening', () => {
  const a1: Row = { name: 'a1', depth: 1 };
  const a2: Row = { name: 'a2', depth: 1 };
  const a: Row = { name: 'a', depth: 0, children: [a1, a2] };
  const b1: Row = { name: 'b1', depth: 1 };
  const b: Row = { name: 'b', depth: 0, children: [b1] };
  const roots: readonly Row[] = [a, b];

  function renderTree(expanded: ReadonlySet<string>): {
    readonly container: HTMLElement;
    readonly onToggle: ReturnType<typeof vi.fn<(row: Row) => void>>;
  } {
    const onToggle = vi.fn<(row: Row) => void>();
    const view = render(
      <DataTable
        columns={NAME_CPU_COLUMNS}
        rows={roots}
        rowKey={(row) => row.name}
        tree
        depth={(row) => row.depth ?? 0}
        expanded={expanded}
        onToggle={onToggle}
      />,
    );
    return { container: view.container, onToggle };
  }

  it('renders roots plus children of expanded nodes with per-row depth', () => {
    const { container } = renderTree(new Set(['a']));

    expect(bodyRows(container).map((row) => row.getAttribute('data-key'))).toEqual([
      'a',
      'a1',
      'a2',
      'b',
    ]);
    expect(bodyRows(container).map((row) => row.getAttribute('data-depth'))).toEqual([
      '0',
      '1',
      '1',
      '0',
    ]);
    expect(container.querySelector('tr[data-key="b1"]')).toBeNull();
  });

  it('flattens a different set of children when another node is expanded', () => {
    const { container } = renderTree(new Set(['b']));

    expect(bodyRows(container).map((row) => row.getAttribute('data-key'))).toEqual([
      'a',
      'b',
      'b1',
    ]);
    expect(bodyRows(container).map((row) => row.getAttribute('data-depth'))).toEqual([
      '0',
      '0',
      '1',
    ]);
    expect(container.querySelector('tr[data-key="a1"]')).toBeNull();
  });

  it('calls onToggle with the row when the Expand/Collapse button is clicked', () => {
    const { container, onToggle } = renderTree(new Set(['a']));

    const expandB = toggleButton(container, 'b');
    expect(expandB.getAttribute('aria-label')).toBe('Expand');
    expect(expandB.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(expandB);
    expect(onToggle).toHaveBeenCalledTimes(1);
    expect(onToggle).toHaveBeenCalledWith(b);

    const collapseA = toggleButton(container, 'a');
    expect(collapseA.getAttribute('aria-label')).toBe('Collapse');
    expect(collapseA.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(collapseA);
    expect(onToggle).toHaveBeenLastCalledWith(a);
  });

  it('renders the toggle only on rows with non-empty children', () => {
    const { container } = renderTree(new Set(['a']));

    expect(toggleButton(container, 'a').getAttribute('aria-label')).toBe('Collapse');
    expect(toggleButton(container, 'b').getAttribute('aria-label')).toBe('Expand');
    expect(queryToggleButton(container, 'a1')).toBeNull();
    expect(queryToggleButton(container, 'a2')).toBeNull();
  });

  it('renders no toggle for a row with an empty children array', () => {
    const leaf: Row = { name: 'leaf', depth: 1, children: [] };
    const parent: Row = { name: 'parent', depth: 0, children: [leaf] };
    const view = render(
      <DataTable
        columns={NAME_CPU_COLUMNS}
        rows={[parent]}
        rowKey={(row) => row.name}
        tree
        depth={(row) => row.depth ?? 0}
        expanded={new Set(['parent'])}
        onToggle={vi.fn<(row: Row) => void>()}
      />,
    );

    expect(toggleButton(view.container, 'parent')).not.toBeNull();
    expect(queryToggleButton(view.container, 'leaf')).toBeNull();
  });
});

describe('DataTable heat cells', () => {
  const heatColumns: readonly DataTableColumn<Row>[] = [
    { key: 'name', title: 'Name' },
    { key: 'cpu', title: 'CPU', heat: true },
  ];
  const heatRows: readonly Row[] = [
    { name: 'idle', cpu: 0 },
    { name: 'busy', cpu: 30 },
    { name: 'hot', cpu: 100 },
  ];

  function renderHeat(): HTMLElement {
    return render(<DataTable columns={heatColumns} rows={heatRows} rowKey={(row) => row.name} />)
      .container;
  }

  it('tints from the numeric key value when heatValue is absent', () => {
    const container = renderHeat();

    const idle = bodyCell(container, 'idle', 'cpu');
    expect(idle.getAttribute('data-heat')).toBe('true');
    expect(idle.getAttribute('data-heat-value')).toBe('0');
    expect(idle.style.getPropertyValue('--kos-tm-heat-opacity')).toBe('0.08');

    const busy = bodyCell(container, 'busy', 'cpu');
    expect(busy.getAttribute('data-heat-value')).toBe('30');
    expect(busy.style.getPropertyValue('--kos-tm-heat-opacity')).toBe('0.3');

    const hot = bodyCell(container, 'hot', 'cpu');
    expect(hot.getAttribute('data-heat-value')).toBe('100');
    expect(hot.style.getPropertyValue('--kos-tm-heat-opacity')).toBe('0.6');
  });

  it('tints from heatValue when the column key has no matching raw field', () => {
    interface MetricRow {
      readonly name: string;
      readonly cpuMillis?: number;
    }
    const columns: readonly DataTableColumn<MetricRow>[] = [
      { key: 'name', title: 'Name' },
      {
        key: 'cpu',
        title: 'CPU',
        align: 'end',
        heat: true,
        heatValue: (row) => row.cpuMillis ?? null,
        render: (row) => (row.cpuMillis !== undefined ? `${row.cpuMillis}m` : ''),
      },
    ];
    const rows: readonly MetricRow[] = [
      { name: 'idle' },
      { name: 'busy', cpuMillis: 50 },
      { name: 'hot', cpuMillis: 200 },
    ];
    const { container } = render(
      <DataTable columns={columns} rows={rows} rowKey={(row) => row.name} />,
    );

    const idle = bodyCell(container, 'idle', 'cpu');
    expect(idle.getAttribute('data-heat')).toBe('true');
    expect(idle.getAttribute('data-heat-value')).toBeNull();
    expect(idle.style.getPropertyValue('--kos-tm-heat-opacity')).toBe('');

    const busy = bodyCell(container, 'busy', 'cpu');
    expect(busy.getAttribute('data-heat-value')).toBe('50');
    expect(busy.style.getPropertyValue('--kos-tm-heat-opacity')).toBe('0.5');

    const hot = bodyCell(container, 'hot', 'cpu');
    expect(hot.getAttribute('data-heat-value')).toBe('200');
    expect(hot.style.getPropertyValue('--kos-tm-heat-opacity')).toBe('0.6');
  });

  it('leaves non-heat columns without heat data', () => {
    const container = renderHeat();

    for (const row of heatRows) {
      const cell = bodyCell(container, row.name, 'name');
      expect(cell.getAttribute('data-heat')).toBe('false');
      expect(cell.getAttribute('data-heat-value')).toBeNull();
      expect(cell.style.getPropertyValue('--kos-tm-heat-opacity')).toBe('');
    }
  });
});

describe('DataTable states', () => {
  it('shows the loading row', () => {
    const { container } = render(
      <DataTable
        columns={NAME_CPU_COLUMNS}
        rows={[]}
        rowKey={(row) => row.name}
        loading
        error="stale error"
      />,
    );

    expect(screen.getByText('Loading...')).toBeTruthy();
    expect(screen.queryByText('stale error')).toBeNull();
    expect(container.querySelector('.kos-tm-table')?.getAttribute('data-loading')).toBe('true');
  });

  it('shows the error message when not loading', () => {
    render(
      <DataTable
        columns={NAME_CPU_COLUMNS}
        rows={[]}
        rowKey={(row) => row.name}
        error="metrics unavailable"
      />,
    );

    expect(screen.getByText('metrics unavailable')).toBeTruthy();
    expect(screen.queryByText('Loading...')).toBeNull();
  });

  it('shows the empty message for zero rows without error or loading', () => {
    render(
      <DataTable
        columns={NAME_CPU_COLUMNS}
        rows={[]}
        rowKey={(row) => row.name}
        emptyMessage="Nothing running"
      />,
    );

    expect(screen.getByText('Nothing running')).toBeTruthy();
  });

  it('uses the column render prop for cell content', () => {
    const columns: readonly DataTableColumn<Row>[] = [
      { key: 'name', title: 'Name' },
      {
        key: 'cpu',
        title: 'CPU',
        render: (row) => (row.cpu === undefined ? 'n/a' : `${row.cpu}%`),
      },
    ];
    render(<DataTable columns={columns} rows={flatRows} rowKey={(row) => row.name} />);

    expect(screen.getByText('5%')).toBeTruthy();
    expect(screen.getByText('7%')).toBeTruthy();
  });
});

describe('DataTable activation', () => {
  it('activates a row on double-click and on Enter', () => {
    const onActivate = vi.fn<(row: Row) => void>();
    const { container } = render(
      <DataTable
        columns={NAME_CPU_COLUMNS}
        rows={flatRows}
        rowKey={(row) => row.name}
        onActivate={onActivate}
      />,
    );
    const webRow = bodyRow(container, 'web');

    fireEvent.dblClick(webRow);
    expect(onActivate).toHaveBeenCalledTimes(1);
    expect(onActivate).toHaveBeenCalledWith(flatRows[0]);

    fireEvent.keyDown(webRow, { key: 'Enter' });
    expect(onActivate).toHaveBeenCalledTimes(2);
    expect(onActivate).toHaveBeenLastCalledWith(flatRows[0]);
  });

  it('marks the active row via data-active and aria-selected', () => {
    const onActivate = vi.fn<(row: Row) => void>();
    const { container } = render(
      <DataTable
        columns={NAME_CPU_COLUMNS}
        rows={flatRows}
        rowKey={(row) => row.name}
        onActivate={onActivate}
        activeKey="db"
      />,
    );

    expect(bodyRow(container, 'db').getAttribute('data-active')).toBe('true');
    expect(bodyRow(container, 'db').getAttribute('aria-selected')).toBe('true');
    expect(bodyRow(container, 'web').getAttribute('data-active')).toBe('false');
    expect(bodyRow(container, 'web').getAttribute('aria-selected')).toBe('false');
  });
});
