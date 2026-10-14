// Pure formatters for Task Manager 2.0 (tasks.md §6 P0-D).

const BYTE_UNITS = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'] as const;

export function formatCpu(millis: number): string {
  if (!Number.isFinite(millis)) return '\u2014';
  return `${Math.round(millis)} m`;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '\u2014';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(digits)} ${BYTE_UNITS[unit]}`;
}

export function formatRate(bytesPerSecond: number): string {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond < 0) return '\u2014';
  return `${formatBytes(bytesPerSecond)}/s`;
}

export function formatPercent(value: number): string {
  if (!Number.isFinite(value)) return '\u2014';
  return `${Math.round(value)}%`;
}

export function formatCapacity(used: number, total: number): string {
  if (!Number.isFinite(used) || !Number.isFinite(total) || total <= 0) return '\u2014';
  return `${formatBytes(used)} / ${formatBytes(total)} (${formatPercent((used / total) * 100)})`;
}
