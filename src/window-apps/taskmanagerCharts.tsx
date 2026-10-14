// Chart primitives for Task Manager 2.0 (tasks.md §6 C1).
// Presentational, dependency-free SVG; colours come from the --kos-* tokens or a
// caller-supplied CSS colour (including `var(--kos-*)`).
import {
  useEffect,
  useId,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactElement,
  type RefObject,
} from 'react';
import type { MetricSeries, SeriesSample } from './taskmanagerTypes';
import './taskmanagerCharts.css';

const DEFAULT_SPARKLINE_HEIGHT = 24;
const DEFAULT_CHART_HEIGHT = 200;
const CHART_PADDING = { top: 18, right: 14, bottom: 24, left: 56 } as const;

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function resolveHeight(height: number | string | undefined, fallback: number): number {
  if (typeof height === 'number' && Number.isFinite(height) && height > 0) return height;
  if (typeof height === 'string') {
    const parsed = Number.parseFloat(height);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return fallback;
}

function nonNegative(values: readonly number[]): number[] {
  return values.map((value) => (Number.isFinite(value) && value > 0 ? value : 0));
}

function formatTick(value: number): string {
  if (!Number.isFinite(value)) return '';
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

function niceMax(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 1;
  const exponent = Math.floor(Math.log10(value));
  const magnitude = 10 ** exponent;
  const normalized = value / magnitude;
  const factor = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return factor * magnitude;
}

function pickScale(max: number): { readonly factor: number; readonly prefix: string } {
  if (max >= 1e12) return { factor: 1e12, prefix: 'T' };
  if (max >= 1e9) return { factor: 1e9, prefix: 'G' };
  if (max >= 1e6) return { factor: 1e6, prefix: 'M' };
  if (max >= 1e3) return { factor: 1e3, prefix: 'k' };
  return { factor: 1, prefix: '' };
}

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return 'now';
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  return `${(ms / 3_600_000).toFixed(1)}h`;
}

function formatClock(time: number): string {
  if (!Number.isFinite(time)) return '';
  return new Date(time).toLocaleTimeString();
}

function nearestIndex(samples: readonly SeriesSample[], time: number): number {
  let best = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  samples.forEach((sample, index) => {
    const distance = Math.abs(sample.t - time);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = index;
    }
  });
  return best;
}

function seriesColor(series: MetricSeries): string {
  return series.color ?? 'var(--kos-accent)';
}

function useElementWidth(): readonly [RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const element = ref.current;
    if (element === null) return undefined;

    const measure = () => setWidth(element.clientWidth);
    measure();

    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure);
      return () => window.removeEventListener('resize', measure);
    }

    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return [ref, width];
}

export interface SparklineProps {
  readonly values: readonly number[];
  readonly height?: number | string;
  readonly stroke?: string;
  readonly className?: string;
}

export function Sparkline({ values, height, stroke, className }: SparklineProps): ReactElement {
  const points = nonNegative(values);
  const count = points.length;
  const min = count > 0 ? Math.min(...points) : 0;
  const max = count > 0 ? Math.max(...points) : 0;
  const span = max - min;
  const pad = span > 0 ? span * 0.1 : 1;
  const low = Math.max(0, min - pad);
  const high = max + pad;
  const range = high - low || 1;
  const xAt = (index: number): number => (count <= 1 ? 50 : (index / (count - 1)) * 100);
  const yAt = (value: number): number => 98 - ((value - low) / range) * 96;
  const linePoints = points.map((value, index) => `${xAt(index)},${yAt(value)}`).join(' ');
  const areaPoints = count > 1 ? `0,100 ${linePoints} 100,100` : '';
  const classes = className ? `kos-tm-sparkline ${className}` : 'kos-tm-sparkline';

  return (
    <svg
      className={classes}
      width="100%"
      height={height ?? DEFAULT_SPARKLINE_HEIGHT}
      viewBox="0 0 100 100"
      preserveAspectRatio="none"
      role="img"
      aria-hidden="true"
      data-points={String(count)}
      style={stroke === undefined ? undefined : { color: stroke }}
    >
      {count === 0 ? (
        <line className="kos-tm-sparkline__placeholder" x1="0" y1="99" x2="100" y2="99" />
      ) : (
        <>
          {count > 1 ? <polygon className="kos-tm-sparkline__area" points={areaPoints} /> : null}
          <polyline className="kos-tm-sparkline__line" points={linePoints} fill="none" />
          {count === 1 ? (
            <circle className="kos-tm-sparkline__dot" cx="50" cy={yAt(points[0])} r="1.5" />
          ) : null}
        </>
      )}
    </svg>
  );
}

export interface PerformanceChartProps {
  readonly series: readonly MetricSeries[];
  readonly capacity?: number;
  readonly unit?: string;
  readonly height?: number | string;
  readonly onHover?: (series: MetricSeries | null, index: number | null) => void;
}

export function PerformanceChart({
  series,
  capacity,
  unit,
  height,
  onHover,
}: PerformanceChartProps): ReactElement {
  const [plotRef, width] = useElementWidth();
  const [hoverTime, setHoverTime] = useState<number | null>(null);
  const gradientId = `kos-tm-grad-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;

  const active = series.filter((entry) => entry.samples.length > 0);
  const chartHeight = resolveHeight(height, DEFAULT_CHART_HEIGHT);
  const chartWidth = width > 0 ? width : 0;
  const plotWidth = Math.max(0, chartWidth - CHART_PADDING.left - CHART_PADDING.right);
  const plotHeight = Math.max(0, chartHeight - CHART_PADDING.top - CHART_PADDING.bottom);

  let dataMax = 0;
  let timeMin = Number.POSITIVE_INFINITY;
  let timeMax = Number.NEGATIVE_INFINITY;
  for (const entry of active) {
    for (const sample of entry.samples) {
      if (Number.isFinite(sample.v) && sample.v > dataMax) dataMax = sample.v;
      if (Number.isFinite(sample.t)) {
        if (sample.t < timeMin) timeMin = sample.t;
        if (sample.t > timeMax) timeMax = sample.t;
      }
    }
  }
  if (!Number.isFinite(timeMin) || !Number.isFinite(timeMax)) {
    timeMin = 0;
    timeMax = 0;
  }
  const timeSpan = timeMax - timeMin;

  const capacityMax =
    capacity !== undefined && Number.isFinite(capacity) && capacity > 0 ? capacity : 0;
  const domainMax = niceMax(Math.max(dataMax * 1.05, capacityMax, 1));
  const scale = unit === '%' ? { factor: 1, prefix: '' } : pickScale(domainMax);
  const axisUnit = `${scale.prefix}${unit ?? ''}`;

  const xAtTime = (time: number): number =>
    CHART_PADDING.left + (timeSpan > 0 ? ((time - timeMin) / timeSpan) * plotWidth : plotWidth / 2);
  const yAtValue = (value: number): number =>
    CHART_PADDING.top + plotHeight * (1 - clamp(value / domainMax, 0, 1));
  const linePoints = (entry: MetricSeries): string =>
    entry.samples.map((sample) => `${xAtTime(sample.t)},${yAtValue(sample.v)}`).join(' ');
  const areaPoints = (entry: MetricSeries): string => {
    const base = CHART_PADDING.top + plotHeight;
    const first = xAtTime(entry.samples[0].t);
    const last = xAtTime(entry.samples[entry.samples.length - 1].t);
    return `${first},${base} ${linePoints(entry)} ${last},${base}`;
  };
  const formatValue = (value: number): string => {
    const scaled = value / scale.factor;
    return axisUnit === '%'
      ? `${formatTick(scaled)}%`
      : `${formatTick(scaled)}${axisUnit ? ` ${axisUnit}` : ''}`;
  };

  const ticks = [0, 0.25, 0.5, 0.75, 1].map((fraction) => fraction * domainMax);
  const leftLabel =
    active.length > 0 && active[0].samples.length > 1 ? `-${formatDuration(timeSpan)}` : 'now';

  const handleMove = (event: ReactMouseEvent<SVGRectElement>): void => {
    const bounds = event.currentTarget.getBoundingClientRect();
    if (bounds.width <= 0 || active.length === 0) return;
    const fraction = clamp((event.clientX - bounds.left) / bounds.width, 0, 1);
    const time = timeMin + fraction * timeSpan;
    let chosen = active[0];
    let chosenIndex = nearestIndex(chosen.samples, time);
    let bestDistance = Math.abs(chosen.samples[chosenIndex].t - time);
    for (const entry of active) {
      const index = nearestIndex(entry.samples, time);
      const distance = Math.abs(entry.samples[index].t - time);
      if (distance < bestDistance) {
        bestDistance = distance;
        chosen = entry;
        chosenIndex = index;
      }
    }
    setHoverTime(chosen.samples[chosenIndex].t);
    onHover?.(chosen, chosenIndex);
  };

  const handleLeave = (): void => {
    setHoverTime(null);
    onHover?.(null, null);
  };

  const hoverAt = hoverTime;
  const crosshairX = hoverAt === null ? 0 : xAtTime(hoverAt);
  const tooltipLeft = chartWidth > 0 && hoverAt !== null ? (crosshairX / chartWidth) * 100 : 0;

  return (
    <div
      className="kos-tm-chart"
      data-series={String(series.length)}
      data-capacity={capacity === undefined ? undefined : String(capacity)}
      data-unit={unit}
    >
      {series.length > 0 ? (
        <ul className="kos-tm-chart__legend">
          {series.map((entry) => (
            <li key={entry.key} className="kos-tm-chart__legend-item">
              <span
                className="kos-tm-chart__legend-swatch"
                style={{ background: seriesColor(entry) }}
              />
              {entry.label}
            </li>
          ))}
        </ul>
      ) : null}
      <div className="kos-tm-chart__plot" ref={plotRef} style={{ minHeight: chartHeight }}>
        {chartWidth === 0 || active.length === 0 ? (
          <div className="kos-tm-chart__empty">No data</div>
        ) : (
          <>
            <svg
              className="kos-tm-chart__svg"
              width={chartWidth}
              height={chartHeight}
              viewBox={`0 0 ${chartWidth} ${chartHeight}`}
              role="img"
              aria-label="Performance chart"
            >
              <defs>
                {active.map((entry, index) => (
                  <linearGradient
                    key={entry.key}
                    id={`${gradientId}-${index}`}
                    x1="0"
                    y1="0"
                    x2="0"
                    y2="1"
                  >
                    <stop
                      offset="0%"
                      style={{ stopColor: seriesColor(entry) }}
                      stopOpacity={0.35}
                    />
                    <stop
                      offset="100%"
                      style={{ stopColor: seriesColor(entry) }}
                      stopOpacity={0.02}
                    />
                  </linearGradient>
                ))}
              </defs>
              {ticks.map((tick) => {
                const y = yAtValue(tick);
                return (
                  <g key={tick}>
                    <line
                      className="kos-tm-chart__grid"
                      x1={CHART_PADDING.left}
                      x2={CHART_PADDING.left + plotWidth}
                      y1={y}
                      y2={y}
                    />
                    <text
                      className="kos-tm-chart__axis-label"
                      x={CHART_PADDING.left - 8}
                      y={y + 4}
                      textAnchor="end"
                    >
                      {formatTick(tick / scale.factor)}
                    </text>
                  </g>
                );
              })}
              <text
                className="kos-tm-chart__axis-unit"
                x={CHART_PADDING.left - 8}
                y={CHART_PADDING.top - 6}
                textAnchor="end"
              >
                {axisUnit}
              </text>
              {active.map((entry, index) => (
                <g key={entry.key}>
                  <polygon
                    className="kos-tm-chart__area"
                    points={areaPoints(entry)}
                    fill={`url(#${gradientId}-${index})`}
                  />
                  <polyline
                    className="kos-tm-chart__line"
                    points={linePoints(entry)}
                    fill="none"
                    style={{ color: seriesColor(entry) }}
                  />
                </g>
              ))}
              {hoverAt !== null ? (
                <>
                  <line
                    className="kos-tm-chart__crosshair"
                    x1={crosshairX}
                    x2={crosshairX}
                    y1={CHART_PADDING.top}
                    y2={CHART_PADDING.top + plotHeight}
                  />
                  {active.map((entry) => {
                    const index = nearestIndex(entry.samples, hoverAt);
                    const sample = entry.samples[index];
                    return (
                      <circle
                        key={entry.key}
                        className="kos-tm-chart__marker"
                        cx={xAtTime(sample.t)}
                        cy={yAtValue(sample.v)}
                        r={3}
                        style={{ color: seriesColor(entry) }}
                      />
                    );
                  })}
                </>
              ) : null}
              <text
                className="kos-tm-chart__axis-label"
                x={CHART_PADDING.left}
                y={chartHeight - 6}
                textAnchor="start"
              >
                {leftLabel}
              </text>
              <text
                className="kos-tm-chart__axis-label"
                x={CHART_PADDING.left + plotWidth}
                y={chartHeight - 6}
                textAnchor="end"
              >
                now
              </text>
              <rect
                className="kos-tm-chart__overlay"
                x={CHART_PADDING.left}
                y={CHART_PADDING.top}
                width={plotWidth}
                height={plotHeight}
                fill="none"
                pointerEvents="all"
                onMouseMove={handleMove}
                onMouseLeave={handleLeave}
              />
            </svg>
            {hoverAt !== null ? (
              <div className="kos-tm-chart__tooltip" style={{ left: `${tooltipLeft}%` }}>
                <div className="kos-tm-chart__tooltip-time">{formatClock(hoverAt)}</div>
                {active.map((entry) => {
                  const index = nearestIndex(entry.samples, hoverAt);
                  const sample = entry.samples[index];
                  return (
                    <div key={entry.key} className="kos-tm-chart__tooltip-row">
                      <span
                        className="kos-tm-chart__tooltip-swatch"
                        style={{ background: seriesColor(entry) }}
                      />
                      <span className="kos-tm-chart__tooltip-label">{entry.label}</span>
                      <span className="kos-tm-chart__tooltip-value">{formatValue(sample.v)}</span>
                    </div>
                  );
                })}
              </div>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}

export interface CompositionBarProps {
  readonly used: number;
  readonly total: number;
  readonly label?: string;
}

export function CompositionBar({ used, total, label }: CompositionBarProps): ReactElement {
  const hasTotal = Number.isFinite(total) && total > 0;
  const safeUsed = Number.isFinite(used) && used > 0 ? used : 0;
  const ratio = hasTotal ? clamp(safeUsed / total, 0, 1) : 0;
  const percent = Math.round(ratio * 100);

  return (
    <div
      className="kos-tm-composition-bar"
      role="img"
      aria-label={label === undefined ? `Used ${percent}%` : `${label}: ${percent}%`}
      data-used={String(used)}
      data-total={String(total)}
    >
      {label === undefined ? null : <span className="kos-tm-composition-bar__label">{label}</span>}
      <span className="kos-tm-composition-bar__track">
        <span className="kos-tm-composition-bar__fill" style={{ width: `${percent}%` }} />
      </span>
      <span className="kos-tm-composition-bar__value">{`${percent}%`}</span>
    </div>
  );
}

export interface GaugeProps {
  readonly value: number;
  readonly max: number;
  readonly label: string;
}

const GAUGE_RADIUS = 42;
const GAUGE_CIRCUMFERENCE = 2 * Math.PI * GAUGE_RADIUS;
const GAUGE_ARC = GAUGE_CIRCUMFERENCE * 0.75;

export function Gauge({ value, max, label }: GaugeProps): ReactElement {
  const hasMax = Number.isFinite(max) && max > 0;
  const safeValue = Number.isFinite(value) && value > 0 ? value : 0;
  const ratio = hasMax ? clamp(safeValue / max, 0, 1) : 0;
  const percent = Math.round(ratio * 100);
  const dash = GAUGE_ARC * ratio;

  return (
    <div
      className="kos-tm-gauge"
      role="img"
      aria-label={`${label}: ${percent}%`}
      data-value={String(value)}
      data-max={String(max)}
    >
      <svg className="kos-tm-gauge__svg" viewBox="0 0 100 100" aria-hidden="true" focusable="false">
        <circle
          className="kos-tm-gauge__track"
          cx="50"
          cy="50"
          r={GAUGE_RADIUS}
          fill="none"
          strokeWidth={10}
          strokeDasharray={`${GAUGE_ARC} ${GAUGE_CIRCUMFERENCE}`}
          strokeLinecap="round"
          transform="rotate(135 50 50)"
        />
        <circle
          className="kos-tm-gauge__value"
          cx="50"
          cy="50"
          r={GAUGE_RADIUS}
          fill="none"
          strokeWidth={10}
          strokeDasharray={`${dash} ${GAUGE_CIRCUMFERENCE}`}
          strokeLinecap="round"
          transform="rotate(135 50 50)"
        />
      </svg>
      <span className="kos-tm-gauge__readout">
        <span className="kos-tm-gauge__number">{`${percent}%`}</span>
        <span className="kos-tm-gauge__label">{label}</span>
      </span>
    </div>
  );
}
