// Shared detail-flyout primitives for Task Manager 2.0 (tasks.md §11.1 + V1/V3/V4).
//
// The flyouts replace the dropped breadcrumb drill-down (decision 1): workloads show
// summary/children/logs, services show ports/selector/backing pods, pods show logs and
// nodes reuse the node detail panel. Presentational — only PodLogsPanel and
// NodeDetailPanel talk to the cluster, both through `clusterClient`.
import { useEffect, useState, type ReactElement, type ReactNode } from 'react';
import { clusterClient } from '../cluster/client';
import type { NodeDetailInfo } from '../cluster/client';

export interface DetailFlyoutProps {
  readonly title: string;
  readonly subtitle?: string;
  readonly ariaLabel?: string;
  readonly onClose: () => void;
  readonly children: ReactNode;
}

/** Right-hand detail panel: header with title/subtitle + close button, scrollable body. */
export function DetailFlyout({
  title,
  subtitle,
  ariaLabel,
  onClose,
  children,
}: DetailFlyoutProps): ReactElement {
  return (
    <aside className="kos-tm-flyout" aria-label={ariaLabel ?? title}>
      <header className="kos-tm-flyout__header">
        <div className="kos-tm-flyout__title-block">
          <h3 className="kos-tm-flyout__title">{title}</h3>
          {subtitle !== undefined && <p className="kos-tm-flyout__subtitle">{subtitle}</p>}
        </div>
        <button type="button" className="kos-tm-flyout__close" aria-label="Close" onClick={onClose}>
          ×
        </button>
      </header>
      <div className="kos-tm-flyout__body">{children}</div>
    </aside>
  );
}

export interface KeyValueItem {
  readonly key: string;
  readonly value: string;
}

/** Definition list of key/value pairs; items with an empty value are skipped. */
export function KeyValueList({
  items,
}: {
  readonly items: readonly { readonly key: string; readonly value: string }[];
}): ReactElement {
  return (
    <dl className="kos-tm-kv">
      {items
        .filter((item) => item.value !== '')
        .map((item) => (
          <div key={item.key}>
            <dt>{item.key}</dt>
            <dd>{item.value}</dd>
          </div>
        ))}
    </dl>
  );
}

/** Titled block inside a flyout body. */
export function FlyoutSection({
  title,
  children,
}: {
  readonly title: string;
  readonly children: ReactNode;
}): ReactElement {
  return (
    <section className="kos-tm-flyout__section">
      <h4 className="kos-tm-flyout__section-title">{title}</h4>
      {children}
    </section>
  );
}

export interface PodLogsPanelProps {
  readonly clusterId?: string;
  readonly namespace: string;
  readonly pod: string;
  readonly container?: string;
  readonly tailLines?: number;
}

/** Loads and renders `clusterClient.getPodLogs` output for a pod. */
export function PodLogsPanel({
  clusterId,
  namespace,
  pod,
  container,
  tailLines,
}: PodLogsPanelProps): ReactElement {
  const [logs, setLogs] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (clusterId === undefined || clusterId === '') {
      setLogs(null);
      setError(null);
      setLoading(false);
      return;
    }

    let active = true;
    setLoading(true);
    setError(null);
    setLogs(null);

    void clusterClient
      .getPodLogs(clusterId, namespace, pod, container, tailLines)
      .then((text) => {
        if (!active) return;
        setLogs(text);
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
  }, [clusterId, namespace, pod, container, tailLines]);

  if (loading) {
    return <p className="kos-tm-flyout__hint">Loading logs…</p>;
  }
  if (error !== null) {
    return <p className="kos-tm-flyout__error">{error}</p>;
  }
  if (logs === null || logs === '') {
    return <p className="kos-tm-flyout__hint">No logs.</p>;
  }
  return (
    <pre className="kos-tm-flyout__logs" aria-label="Pod logs">
      {logs}
    </pre>
  );
}

export interface NodeDetailPanelProps {
  readonly clusterId?: string;
  readonly name: string;
}

function sortedResourceItems(record: Readonly<Record<string, string>>): readonly KeyValueItem[] {
  return Object.keys(record)
    .sort()
    .map((key) => ({ key, value: record[key] }));
}

/** Loads `clusterClient.getNode` and renders status, capacities, conditions and addresses. */
export function NodeDetailPanel({ clusterId, name }: NodeDetailPanelProps): ReactElement {
  const [detail, setDetail] = useState<NodeDetailInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (clusterId === undefined || clusterId === '') {
      setDetail(null);
      setError(null);
      setLoading(false);
      return;
    }

    let active = true;
    setLoading(true);
    setError(null);
    setDetail(null);

    void clusterClient
      .getNode(clusterId, name)
      .then((node) => {
        if (!active) return;
        setDetail(node);
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
  }, [clusterId, name]);

  if (loading) {
    return <p className="kos-tm-flyout__hint">Loading…</p>;
  }
  if (error !== null) {
    return <p className="kos-tm-flyout__error">{error}</p>;
  }
  if (detail === null) {
    return <p className="kos-tm-flyout__hint">No node data.</p>;
  }

  return (
    <>
      <FlyoutSection title="Summary">
        <KeyValueList
          items={[
            { key: 'Status', value: detail.status },
            { key: 'Version', value: detail.version },
            { key: 'Roles', value: detail.roles.join(', ') },
            // NodeDetailInfo carries a single version field — it is the kubelet version.
            { key: 'Kubelet', value: detail.version },
          ]}
        />
      </FlyoutSection>
      <FlyoutSection title="Capacity">
        <KeyValueList items={sortedResourceItems(detail.capacity)} />
      </FlyoutSection>
      <FlyoutSection title="Allocatable">
        <KeyValueList items={sortedResourceItems(detail.allocatable)} />
      </FlyoutSection>
      <FlyoutSection title="Conditions">
        <ul className="kos-tm-flyout__list">
          {detail.conditions.map((condition) => (
            <li key={condition.type}>{`${condition.type}: ${condition.status}`}</li>
          ))}
        </ul>
      </FlyoutSection>
      <FlyoutSection title="Addresses">
        <ul className="kos-tm-flyout__list">
          {detail.addresses.map((address) => (
            <li key={`${address.type}:${address.address}`}>
              {`${address.type}: ${address.address}`}
            </li>
          ))}
        </ul>
      </FlyoutSection>
    </>
  );
}
