// Chart primitives for Task Manager 2.0 (Phase 0 stub; C1 in Phase 2 implements the SVG).
import type { ReactElement } from 'react';
import type { MetricSeries } from './taskmanagerTypes';

export interface SparklineProps {
  readonly values: readonly number[];
  readonly height?: number;
  readonly stroke?: string;
  readonly className?: string;
}

export function Sparkline(props: SparklineProps): ReactElement {
  return (
    <svg
      className={props.className}
      height={props.height ?? 24}
      stroke={props.stroke ?? 'currentColor'}
      role="img"
      aria-hidden="true"
      data-points={String(props.values.length)}
    />
  );
}

export interface PerformanceChartProps {
  readonly series: readonly MetricSeries[];
  readonly capacity?: number;
  readonly unit?: string;
  readonly height?: number;
  readonly onHover?: (index: number | null) => void;
}

export function PerformanceChart(props: PerformanceChartProps): ReactElement {
  return (
    <svg
      height={props.height ?? 200}
      role="img"
      aria-label="Performance chart"
      data-series={String(props.series.length)}
      data-capacity={props.capacity === undefined ? undefined : String(props.capacity)}
      data-unit={props.unit}
      onMouseLeave={() => props.onHover?.(null)}
    />
  );
}

export interface CompositionBarProps {
  readonly used: number;
  readonly total: number;
  readonly label?: string;
}

export function CompositionBar(props: CompositionBarProps): ReactElement {
  return (
    <div
      className="kos-tm-composition-bar"
      role="img"
      aria-label={props.label}
      data-used={String(props.used)}
      data-total={String(props.total)}
    />
  );
}

export interface GaugeProps {
  readonly value: number;
  readonly max: number;
  readonly label: string;
}

export function Gauge(props: GaugeProps): ReactElement {
  return (
    <div
      className="kos-tm-gauge"
      role="img"
      aria-label={props.label}
      data-value={String(props.value)}
      data-max={String(props.max)}
    />
  );
}
