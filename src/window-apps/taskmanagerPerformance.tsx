// Performance page (V2, Phase 3) — Performance charts; uses PerformanceChart/Sparkline + series buffer.
import { useMemo, useState, type ReactElement } from 'react';
import { PerformanceChart, Sparkline } from './taskmanagerCharts';
import { usePolledMetrics, useSeriesBuffer } from './taskmanagerHooks';
import type { MetricSeries, TaskManagerViewProps } from './taskmanagerTypes';
import { formatBytes, formatCpu } from './taskmanagerData';

type Resource = 'cpu' | 'memory' | 'disk' | 'network';

export function PerformanceView(props: TaskManagerViewProps): ReactElement {
  const { clusterId, namespace, updateSpeed } = props;
  const metrics = usePolledMetrics({
    clusterId,
    namespace: namespace == null ? undefined : namespace,
    updateSpeed,
  });
  const [resource, setResource] = useState<Resource>('cpu');

  const cpuTotal = metrics.nodes.reduce((sum, n) => sum + (n.cpuMillis ?? 0), 0);
  const memTotal = metrics.nodes.reduce((sum, n) => sum + (n.memoryBytes ?? 0), 0);
  const diskTotal = metrics.nodes.reduce((sum, n) => sum + (n.diskUsedBytes ?? 0), 0);
  const netTotalRx = metrics.nodes.reduce((sum, n) => sum + (n.networkRxBytes ?? 0), 0);
  const netTotalTx = metrics.nodes.reduce((sum, n) => sum + (n.networkTxBytes ?? 0), 0);

  const cpuBuffer = useSeriesBuffer(cpuTotal > 0 ? cpuTotal : null, 60);
  const memBuffer = useSeriesBuffer(memTotal > 0 ? memTotal : null, 60);
  const diskBuffer = useSeriesBuffer(diskTotal > 0 ? diskTotal : null, 60);
  const netRxBuffer = useSeriesBuffer(netTotalRx > 0 ? netTotalRx : null, 60);
  const netTxBuffer = useSeriesBuffer(netTotalTx > 0 ? netTotalTx : null, 60);

  const cpuSeries: MetricSeries[] = useMemo(() => {
    return [
      {
        key: 'cpu',
        label: 'CPU (m)',
        samples: cpuBuffer,
      },
    ];
  }, [cpuBuffer]);

  const memorySeries: MetricSeries[] = useMemo(() => {
    return [
      {
        key: 'memory',
        label: 'Memory (bytes)',
        samples: memBuffer,
      },
    ];
  }, [memBuffer]);

  const diskSeries: MetricSeries[] = useMemo(() => {
    return [
      {
        key: 'disk',
        label: 'Disk (bytes)',
        samples: diskBuffer,
      },
    ];
  }, [diskBuffer]);

  const networkSeries: MetricSeries[] = useMemo(() => {
    return [
      {
        key: 'rx',
        label: 'RX',
        samples: netRxBuffer,
      },
      {
        key: 'tx',
        label: 'TX',
        samples: netTxBuffer,
      },
    ];
  }, [netRxBuffer, netTxBuffer]);

  const currentChart = useMemo(() => {
    if (resource === 'memory') {
      return <PerformanceChart series={memorySeries} unit="B" height={200} />;
    }
    if (resource === 'disk') {
      return <PerformanceChart series={diskSeries} unit="B" height={200} />;
    }
    if (resource === 'network') {
      return <PerformanceChart series={networkSeries} unit="B" height={200} />;
    }
    return <PerformanceChart series={cpuSeries} unit="m" height={200} />;
  }, [resource, cpuSeries, memorySeries, diskSeries, networkSeries]);

  const cpuValues = cpuBuffer.slice(-20).map((s) => s.v);
  const memValues = memBuffer.slice(-20).map((s) => s.v);

  return (
    <div
      className="kos-tm-view kos-tm-view--performance"
      data-page="performance"
      data-speed={updateSpeed}
    >
      <div className="kos-tm-resource-list">
        <button
          type="button"
          className={resource === 'cpu' ? 'active' : ''}
          onClick={() => setResource('cpu')}
        >
          CPU
        </button>
        <button
          type="button"
          className={resource === 'memory' ? 'active' : ''}
          onClick={() => setResource('memory')}
        >
          Memory
        </button>
        <button
          type="button"
          className={resource === 'disk' ? 'active' : ''}
          onClick={() => setResource('disk')}
        >
          Disk
        </button>
        <button
          type="button"
          className={resource === 'network' ? 'active' : ''}
          onClick={() => setResource('network')}
        >
          Network
        </button>
      </div>
      <div className="kos-tm-chart-section">
        {metrics.available === false && (
          <div className="kos-tm-empty">
            Metrics unavailable — install metrics-server to see live data
          </div>
        )}
        {currentChart}
        {resource === 'cpu' && (
          <div className="kos-tm-sparkline-grid">
            <Sparkline values={cpuValues} height={20} />
            <div className="kos-tm-current">Current: {formatCpu(cpuTotal)}</div>
          </div>
        )}
        {resource === 'memory' && (
          <div>
            <Sparkline values={memValues} height={20} />
            <div className="kos-tm-current">Current: {formatBytes(memTotal)}</div>
          </div>
        )}
      </div>
      {!metrics.available && (
        <div className="kos-tm-empty-hint">
          Install metrics-server in the cluster to enable metrics.
        </div>
      )}
    </div>
  );
}
