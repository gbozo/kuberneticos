// Services page (V3, Phase 3) — Services list/table + service detail flyout.
import { useEffect, useMemo, useState, type ReactElement } from 'react';
import { clusterClient } from '../cluster/client';
import type { PodInfo, ServiceInfo } from '../cluster/client';
import { DetailFlyout, FlyoutSection, KeyValueList } from './taskmanagerFlyout';
import { DataTable } from './taskmanagerTable';
import type { DataTableColumn } from './taskmanagerTable';
import type { TaskManagerViewProps } from './taskmanagerTypes';

function rowKey(svc: ServiceInfo): string {
  return `${svc.namespace}/${svc.name}`;
}

/** True when the pod carries every selector entry (an absent selector matches all). */
function matchesSelector(
  pod: PodInfo,
  selector: Readonly<Record<string, string>> | undefined,
): boolean {
  if (selector === undefined || Object.keys(selector).length === 0) return true;
  return Object.entries(selector).every(([key, value]) => pod.labels?.[key] === value);
}

export function ServicesView(props: TaskManagerViewProps): ReactElement {
  const { clusterId, namespace, updateSpeed } = props;
  const [services, setServices] = useState<readonly ServiceInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<ServiceInfo | null>(null);
  const [pods, setPods] = useState<readonly PodInfo[]>([]);
  const [podsLoading, setPodsLoading] = useState(false);
  const [podsError, setPodsError] = useState<string | null>(null);

  useEffect(() => {
    // Services reload with the cluster/namespace — drop any stale selection first.
    setSelected(null);
    if (clusterId === undefined || clusterId === '') {
      setServices([]);
      setLoading(false);
      setError(null);
      return;
    }

    let active = true;
    setLoading(true);
    setError(null);

    void clusterClient
      .listServices(clusterId, namespace == null ? undefined : namespace)
      .then((s) => {
        if (!active) return;
        setServices(s);
        setLoading(false);
      })
      .catch((err) => {
        if (!active) return;
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [clusterId, namespace]);

  // Backing pods for the selected service — loaded once per selection.
  useEffect(() => {
    if (selected === null || clusterId === undefined || clusterId === '') {
      setPods([]);
      setPodsLoading(false);
      setPodsError(null);
      return;
    }

    let active = true;
    setPodsLoading(true);
    setPodsError(null);

    void clusterClient
      .listPods(clusterId, undefined, namespace == null ? undefined : namespace)
      .then((p) => {
        if (!active) return;
        setPods(p);
        setPodsLoading(false);
      })
      .catch((err) => {
        if (!active) return;
        setPodsError(err instanceof Error ? err.message : String(err));
        setPodsLoading(false);
      });

    return () => {
      active = false;
    };
  }, [clusterId, namespace, selected]);

  const columns: readonly DataTableColumn<ServiceInfo>[] = useMemo(
    () => [
      {
        key: 'name',
        title: 'Name',
        render: (row) => row.name,
      },
      {
        key: 'namespace',
        title: 'Namespace',
        render: (row) => row.namespace,
      },
      {
        key: 'type',
        title: 'Type',
        render: (row) => row.type,
      },
      {
        key: 'clusterIP',
        title: 'ClusterIP',
        render: (row) => row.clusterIP,
      },
      {
        key: 'ports',
        title: 'Ports',
        render: (row) => row.ports.map((p) => `${p.port}/${p.protocol}`).join(', '),
      },
    ],
    [],
  );

  const selectorEntries =
    selected === null
      ? []
      : Object.entries(selected.selector ?? {}).sort(([a], [b]) => a.localeCompare(b));
  const backing =
    selected === null ? [] : pods.filter((p) => matchesSelector(p, selected.selector));

  return (
    <div
      className={
        selected === null
          ? 'kos-tm-view kos-tm-view--services'
          : 'kos-tm-view kos-tm-view--services has-flyout'
      }
      data-page="services"
      data-speed={updateSpeed}
    >
      <div className="kos-tm-view__body">
        <DataTable<ServiceInfo>
          columns={columns}
          rows={services}
          rowKey={rowKey}
          onActivate={(row) => setSelected(row)}
          activeKey={selected === null ? undefined : rowKey(selected)}
          loading={loading}
          error={error}
          emptyMessage="No services found"
          ariaLabel="Services"
        />
      </div>
      {selected !== null && (
        <DetailFlyout
          title={selected.name}
          subtitle={`${selected.namespace} · ${selected.type}`}
          ariaLabel={`Service details — ${selected.name}`}
          onClose={() => setSelected(null)}
        >
          <FlyoutSection title="Summary">
            <KeyValueList
              items={[
                { key: 'Type', value: selected.type },
                { key: 'ClusterIP', value: selected.clusterIP },
                { key: 'Ports', value: String(selected.ports.length) },
              ]}
            />
          </FlyoutSection>
          <FlyoutSection title="Ports">
            <table className="kos-tm-flyout__table">
              <thead>
                <tr>
                  <th scope="col">Name</th>
                  <th scope="col">Port</th>
                  <th scope="col">Protocol</th>
                  <th scope="col">Target</th>
                </tr>
              </thead>
              <tbody>
                {selected.ports.map((port, index) => (
                  <tr key={`${port.port}-${port.protocol}-${index}`}>
                    <td>{port.name ?? '—'}</td>
                    <td>{port.port}</td>
                    <td>{port.protocol}</td>
                    <td>{port.targetPort}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </FlyoutSection>
          <FlyoutSection title="Selector">
            {selectorEntries.length > 0 ? (
              <ul className="kos-tm-flyout__list">
                {selectorEntries.map(([key, value]) => (
                  <li key={key}>
                    <code>{`${key}=${value}`}</code>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="kos-tm-flyout__hint">No selector.</p>
            )}
          </FlyoutSection>
          <FlyoutSection title="Backing pods">
            {podsLoading ? (
              <p className="kos-tm-flyout__hint">Loading pods…</p>
            ) : podsError !== null ? (
              <p className="kos-tm-flyout__error">{podsError}</p>
            ) : backing.length > 0 ? (
              <ul className="kos-tm-flyout__list">
                {backing.map((pod) => (
                  <li key={`${pod.namespace}/${pod.name}`}>
                    <span>{pod.name}</span>
                    <span className="kos-tm-flyout__muted">{pod.phase}</span>
                    <span className="kos-tm-flyout__muted">{pod.node ?? ''}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="kos-tm-flyout__hint">No matching pods.</p>
            )}
          </FlyoutSection>
        </DetailFlyout>
      )}
    </div>
  );
}
