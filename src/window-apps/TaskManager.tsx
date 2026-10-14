// Task Manager 2.0 shell (Phase 4, G1).
//
// Polling decision: each page owns its own `usePolledMetrics` loop (V1/V2/V4 call it
// directly) because tasks.md §7 forbids G1 from editing other tasks' files; the shell
// additionally calls `usePolledMetrics` for the hero totals. Keep the shell hook call
// only inside <Hero> so it only runs on the workloads/performance pages.
import {
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactElement,
} from 'react';
import { clusterClient } from '../cluster/client';
import type { NamespaceInfo, NodeInfo, NodeMetrics } from '../cluster/client';
import { Icon, type KosIconName } from '../components/ui';
import { Gauge } from './taskmanagerCharts';
import { TaskManagerCommandBar } from './taskmanagerCommandBar';
import { useLocalPref, usePolledMetrics } from './taskmanagerHooks';
import {
  DEFAULT_TASK_MANAGER_PAGE,
  DEFAULT_UPDATE_SPEED,
  type NamespaceFilter,
  type TaskManagerPage,
  type TaskManagerViewProps,
  type UpdateSpeed,
} from './taskmanagerTypes';
import { InventoryView, PerformanceView, ProcessesView, ServicesView } from './taskmanagerViews';
import type { WindowAppProps } from './types';
import './taskmanager.css';
import './taskmanagerViews.css';

type AsyncState<T> =
  { status: 'loading' } | { status: 'ready'; data: T } | { status: 'error'; message: string };

function useLoaded<T>(key: string, load: () => Promise<T>): AsyncState<T> {
  const loadRef = useRef(load);
  loadRef.current = load;
  const [state, setState] = useState<AsyncState<T>>({ status: 'loading' });

  useEffect(() => {
    let active = true;
    setState({ status: 'loading' });
    loadRef.current().then(
      (data) => {
        if (active) setState({ status: 'ready', data });
      },
      (error: unknown) => {
        if (active) {
          setState({
            status: 'error',
            message: error instanceof Error ? error.message : String(error),
          });
        }
      },
    );
    return () => {
      active = false;
    };
  }, [key]);

  return state;
}

interface RailItem {
  readonly id: TaskManagerPage;
  readonly label: string;
  readonly icon: KosIconName;
}

const RAIL_ITEMS: readonly RailItem[] = [
  { id: 'workloads', label: 'Workloads', icon: 'layers' },
  { id: 'performance', label: 'Performance', icon: 'graph' },
  { id: 'services', label: 'Services', icon: 'plug' },
  { id: 'pods', label: 'Pods', icon: 'pod' },
  { id: 'namespaces', label: 'Namespaces', icon: 'folder' },
  { id: 'nodes', label: 'Nodes', icon: 'server' },
];

const SETTINGS_ITEM: RailItem = { id: 'settings', label: 'Settings', icon: 'settings' };

const PAGE_ORDER: readonly TaskManagerPage[] = [...RAIL_ITEMS.map((item) => item.id), 'settings'];

function RailButton({
  item,
  active,
  onSelect,
}: {
  readonly item: RailItem;
  readonly active: boolean;
  readonly onSelect: () => void;
}): ReactElement {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      className={active ? 'kos-taskmanager__rail-item is-active' : 'kos-taskmanager__rail-item'}
      onClick={onSelect}
    >
      <Icon name={item.icon} size={16} />
      <span className="kos-taskmanager__rail-label">{item.label}</span>
    </button>
  );
}

function HeroGauge({
  label,
  used,
  max,
  available,
}: {
  readonly label: string;
  readonly used: number;
  readonly max: number;
  readonly available: boolean;
}): ReactElement {
  if (!available || !Number.isFinite(max) || max <= 0) {
    return (
      <div className="kos-taskmanager__gauge" role="img" aria-label={`${label}: unavailable`}>
        <span className="kos-taskmanager__gauge-value">{'\u2014'}</span>
        <span className="kos-taskmanager__gauge-label">{label}</span>
      </div>
    );
  }
  return <Gauge value={used} max={max} label={label} />;
}

interface HeroProps {
  readonly clusterId?: string;
  readonly clusterName?: string;
  readonly namespace: NamespaceFilter;
  readonly updateSpeed: UpdateSpeed;
}

function Hero({ clusterId, clusterName, namespace, updateSpeed }: HeroProps): ReactElement {
  const nodeState = useLoaded(`hero-nodes:${clusterId ?? ''}`, () =>
    clusterId === undefined
      ? Promise.resolve([] as readonly NodeInfo[])
      : clusterClient.listNodes(clusterId),
  );
  const metrics = usePolledMetrics({
    clusterId,
    namespace: namespace === null ? undefined : namespace,
    updateSpeed,
  });

  const nodes = nodeState.status === 'ready' ? nodeState.data : [];
  const version = nodes.find((node) => node.version !== undefined && node.version !== '')?.version;

  const total = (pick: (node: NodeMetrics) => number | undefined): number =>
    metrics.nodes.reduce((sum, node) => sum + (pick(node) ?? 0), 0);

  const gauges: readonly { label: string; used: number; max: number }[] = [
    {
      label: 'CPU',
      used: total((node) => node.cpuMillis),
      max: total((node) => node.cpuAllocatableMillis),
    },
    {
      label: 'Memory',
      used: total((node) => node.memoryBytes),
      max: total((node) => node.memoryAllocatableBytes),
    },
    {
      label: 'Disk',
      used: total((node) => node.diskUsedBytes),
      max: total((node) => node.diskCapacityBytes),
    },
  ];

  return (
    <section className="kos-taskmanager__hero" aria-label="Cluster overview">
      <div className="kos-taskmanager__hero-info">
        <h2 className="kos-taskmanager__hero-title">{clusterName ?? clusterId ?? 'Cluster'}</h2>
        <dl className="kos-taskmanager__hero-meta">
          <div className="kos-taskmanager__hero-meta-item">
            <dt>Version</dt>
            <dd>{version ?? '\u2014'}</dd>
          </div>
          <div className="kos-taskmanager__hero-meta-item">
            <dt>Nodes</dt>
            <dd>{nodes.length}</dd>
          </div>
        </dl>
      </div>
      <div className="kos-taskmanager__hero-gauges">
        {gauges.map((gauge) => (
          <HeroGauge
            key={gauge.label}
            label={gauge.label}
            used={gauge.used}
            max={gauge.max}
            available={metrics.available}
          />
        ))}
      </div>
    </section>
  );
}

export function TaskManager(_props: WindowAppProps): ReactElement {
  const [page, setPage] = useLocalPref<TaskManagerPage>('kos.tm.page', DEFAULT_TASK_MANAGER_PAGE);
  const [updateSpeed, setUpdateSpeed] = useLocalPref<UpdateSpeed>(
    'kos.tm.updateSpeed',
    DEFAULT_UPDATE_SPEED,
  );
  const [namespace, setNamespace] = useLocalPref<NamespaceFilter>('kos.tm.namespace', null);
  const [railCollapsed, setRailCollapsed] = useLocalPref<boolean>('kos.tm.railCollapsed', false);
  const [refreshNonce, setRefreshNonce] = useState(0);
  const [clusterId, setClusterId] = useState<string | undefined>(undefined);

  const clusters = useLoaded('clusters', () => clusterClient.listClusters());
  const namespaces = useLoaded(`namespaces:${clusterId ?? ''}`, () =>
    clusterId === undefined
      ? Promise.resolve([] as readonly NamespaceInfo[])
      : clusterClient.listNamespaces(clusterId),
  );

  useEffect(() => {
    if (clusters.status !== 'ready' || clusters.data.length === 0) return;
    setClusterId((prev) => {
      if (prev !== undefined && clusters.data.some((cluster) => cluster.id === prev)) return prev;
      return clusters.data[0].id;
    });
  }, [clusters]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (!event.ctrlKey || event.key !== 'Tab') return;
      event.preventDefault();
      const index = PAGE_ORDER.indexOf(page);
      const next = PAGE_ORDER[(index + 1) % PAGE_ORDER.length] ?? DEFAULT_TASK_MANAGER_PAGE;
      setPage(next);
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [page, setPage]);

  const handleRailKeyDown = (event: ReactKeyboardEvent<HTMLElement>): void => {
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
    const items = Array.from(
      event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]'),
    );
    if (items.length === 0) return;
    event.preventDefault();
    const currentIndex = items.findIndex((item) => item === document.activeElement);
    if (currentIndex === -1) {
      items[0].focus();
      return;
    }
    const step = event.key === 'ArrowDown' ? 1 : -1;
    items[(currentIndex + step + items.length) % items.length].focus();
  };

  const handleNamespaceChange = (event: ChangeEvent<HTMLSelectElement>): void => {
    setNamespace(event.target.value === 'all' ? null : event.target.value);
  };

  const handleClusterChange = (event: ChangeEvent<HTMLSelectElement>): void => {
    setClusterId(event.target.value);
  };

  const clusterName =
    clusters.status === 'ready'
      ? clusters.data.find((cluster) => cluster.id === clusterId)?.name
      : undefined;
  const hasMultipleClusters = clusters.status === 'ready' && clusters.data.length > 1;

  const viewProps: TaskManagerViewProps = { clusterId, namespace, updateSpeed };
  const showHero = page === 'workloads' || page === 'performance';

  // Re-keying the page forces a remount (and therefore a refetch) on Refresh.
  const pageKey = `${page}:${refreshNonce}`;
  const renderPage = (): ReactElement => {
    switch (page) {
      case 'workloads':
        return <ProcessesView key={pageKey} {...viewProps} />;
      case 'performance':
        return <PerformanceView key={pageKey} {...viewProps} />;
      case 'services':
        return <ServicesView key={pageKey} {...viewProps} />;
      default:
        return <InventoryView key={pageKey} {...viewProps} page={page} />;
    }
  };

  const namespaceOptions = namespaces.status === 'ready' ? namespaces.data : [];

  return (
    <div className="kos-taskmanager" data-collapsed={railCollapsed}>
      <div className="kos-taskmanager__body">
        <nav
          className="kos-taskmanager__rail"
          role="tablist"
          aria-orientation="vertical"
          aria-label="Task Manager"
          onKeyDown={handleRailKeyDown}
        >
          <button
            type="button"
            className="kos-taskmanager__rail-toggle"
            onClick={() => setRailCollapsed(!railCollapsed)}
            title="Collapse/expand navigation"
            aria-label="Toggle navigation"
          >
            <Icon name="menu" size={16} />
          </button>
          <ul className="kos-taskmanager__rail-list">
            {RAIL_ITEMS.map((item) => (
              <li key={item.id}>
                <RailButton
                  item={item}
                  active={page === item.id}
                  onSelect={() => setPage(item.id)}
                />
              </li>
            ))}
          </ul>
          <div className="kos-taskmanager__rail-footer">
            <RailButton
              item={SETTINGS_ITEM}
              active={page === SETTINGS_ITEM.id}
              onSelect={() => setPage(SETTINGS_ITEM.id)}
            />
          </div>
        </nav>
        <section className="kos-taskmanager__main">
          {clusters.status === 'loading' ? (
            <p className="kos-taskmanager__status">Loading…</p>
          ) : clusters.status === 'error' ||
            (clusters.status === 'ready' && clusters.data.length === 0) ? (
            <p className="kos-taskmanager__status is-error">
              No clusters configured — start the Go server
            </p>
          ) : (
            <>
              {/*
                The pages own their group-by and search controls (ProcessesView renders
                its own toolbar), so the shell deliberately omits `onGroupByChange` and
                `onQueryChange`; the built-in namespace select is a non-functional stub,
                hence the real namespace picker is passed in `children` instead.
              */}
              <TaskManagerCommandBar
                page={page}
                updateSpeed={updateSpeed}
                onUpdateSpeedChange={setUpdateSpeed}
                onRefresh={() => setRefreshNonce((value) => value + 1)}
              >
                <select
                  className="kos-taskmanager__select"
                  aria-label="Namespace"
                  value={namespace === null ? 'all' : namespace}
                  onChange={handleNamespaceChange}
                >
                  <option value="all">All namespaces</option>
                  {namespaceOptions.map((item) => (
                    <option key={item.name} value={item.name}>
                      {item.name}
                    </option>
                  ))}
                </select>
                {hasMultipleClusters ? (
                  <select
                    className="kos-taskmanager__select"
                    aria-label="Cluster"
                    value={clusterId ?? ''}
                    onChange={handleClusterChange}
                  >
                    {clusters.status === 'ready'
                      ? clusters.data.map((cluster) => (
                          <option key={cluster.id} value={cluster.id}>
                            {cluster.name}
                          </option>
                        ))
                      : null}
                  </select>
                ) : null}
              </TaskManagerCommandBar>
              {showHero ? (
                <Hero
                  clusterId={clusterId}
                  clusterName={clusterName}
                  namespace={namespace}
                  updateSpeed={updateSpeed}
                />
              ) : null}
              <div className="kos-taskmanager__content">{renderPage()}</div>
            </>
          )}
        </section>
      </div>
    </div>
  );
}

export default TaskManager;
