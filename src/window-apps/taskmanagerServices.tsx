// Services page (V3, Phase 3) — Services list/table.
import { useEffect, useMemo, useState, type ReactElement } from 'react';
import { clusterClient } from '../cluster/client';
import type { ServiceInfo } from '../cluster/client';
import { DataTable } from './taskmanagerTable';
import type { DataTableColumn } from './taskmanagerTable';
import type { TaskManagerViewProps } from './taskmanagerTypes';

function rowKey(svc: ServiceInfo): string {
  return `${svc.namespace}/${svc.name}`;
}

export function ServicesView(props: TaskManagerViewProps): ReactElement {
  const { clusterId, namespace, updateSpeed } = props;
  const [services, setServices] = useState<readonly ServiceInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
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

  return (
    <div
      className="kos-tm-view kos-tm-view--services"
      data-page="services"
      data-speed={updateSpeed}
    >
      <DataTable<ServiceInfo>
        columns={columns}
        rows={services}
        rowKey={rowKey}
        loading={loading}
        error={error}
        emptyMessage="No services found"
        ariaLabel="Services"
      />
    </div>
  );
}
