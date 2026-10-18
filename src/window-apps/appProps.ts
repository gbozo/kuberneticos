// Type-safe readers for app-specific `props` payloads (WindowAppProps.props is
// an untyped `Record<string, unknown>` because the reducer is app-agnostic).

export function stringProp(props: Record<string, unknown>, key: string): string | undefined {
  const value = props[key];
  return typeof value === 'string' ? value : undefined;
}

/** Splits a `kos.dev/x-app` annotation value like "firefox --private-window" into argv. */
export function commandFromAnnotation(annotation: string): string[] {
  return annotation
    .trim()
    .split(/\s+/)
    .filter((part) => part !== '');
}

export function stringListProp(
  props: Record<string, unknown>,
  key: string,
): readonly string[] | undefined {
  const value = props[key];
  if (!Array.isArray(value)) return undefined;
  if (!value.every((entry) => typeof entry === 'string')) return undefined;
  return value as string[];
}
