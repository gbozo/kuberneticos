// Command bar for Task Manager 2.0
import type { ChangeEvent, ReactElement, ReactNode } from 'react';
import { useId } from 'react';
import './taskmanager.css';

import type { GroupBy, NamespaceFilter, UpdateSpeed } from './taskmanagerTypes';

export interface TaskManagerCommandBarProps {
  readonly page: string;
  readonly groupBy?: GroupBy;
  readonly onGroupByChange?: (groupBy: GroupBy) => void;
  readonly namespace?: NamespaceFilter;
  readonly onNamespaceChange?: (namespace: NamespaceFilter) => void;
  readonly updateSpeed?: UpdateSpeed;
  readonly onUpdateSpeedChange?: (updateSpeed: UpdateSpeed) => void;
  readonly query?: string;
  readonly onQueryChange?: (query: string) => void;
  readonly onRefresh?: () => void;
  readonly children?: ReactNode;
}

const GROUP_BY_OPTIONS: Array<{ value: GroupBy; label: string }> = [
  { value: 'deployment', label: 'Deployment' },
  { value: 'replicaset', label: 'ReplicaSet' },
  { value: 'pod', label: 'Pod' },
  { value: 'namespace', label: 'Namespace' },
  { value: 'node', label: 'Node' },
];

const SPEED_OPTIONS: Array<{ value: UpdateSpeed; label: string }> = [
  { value: 'paused', label: 'Paused' },
  { value: 'low', label: 'Low (5s)' },
  { value: 'normal', label: 'Normal (2s)' },
  { value: 'high', label: 'High (1s)' },
];

export function TaskManagerCommandBar(props: TaskManagerCommandBarProps): ReactElement {
  const {
    groupBy,
    onGroupByChange,
    namespace,
    onNamespaceChange,
    updateSpeed,
    onUpdateSpeedChange,
    query = '',
    onQueryChange,
    onRefresh,
    children,
  } = props;

  const searchId = useId();
  const groupById = useId();
  const speedId = useId();
  const namespaceId = useId();

  const handleSearchChange = (e: ChangeEvent<HTMLInputElement>): void => {
    if (onQueryChange) {
      onQueryChange(e.target.value);
    }
  };

  const handleGroupByChange = (e: ChangeEvent<HTMLSelectElement>): void => {
    if (onGroupByChange) {
      onGroupByChange(e.target.value as GroupBy);
    }
  };

  const handleSpeedChange = (e: ChangeEvent<HTMLSelectElement>): void => {
    if (onUpdateSpeedChange) {
      onUpdateSpeedChange(e.target.value as UpdateSpeed);
    }
  };

  const handleNamespaceChange = (e: ChangeEvent<HTMLSelectElement>): void => {
    if (onNamespaceChange) {
      onNamespaceChange(e.target.value === 'all' ? null : e.target.value);
    }
  };

  return (
    <div className="kos-tm-command-bar" role="toolbar" aria-label="Task Manager commands">
      <div className="kos-tm-command-bar__left">{children}</div>
      <div className="kos-tm-command-bar__right">
        <button
          type="button"
          className="kos-tm-command-bar__button"
          onClick={onRefresh}
          aria-label="Refresh"
        >
          ↻ Refresh
        </button>

        {onGroupByChange !== undefined && (
          <div className="kos-tm-command-bar__group">
            <label htmlFor={groupById} className="kos-tm-command-bar__label">
              Group by
            </label>
            <select
              id={groupById}
              className="kos-tm-command-bar__select"
              value={groupBy ?? 'deployment'}
              onChange={handleGroupByChange}
            >
              {GROUP_BY_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>
        )}

        {onNamespaceChange !== undefined && (
          <div className="kos-tm-command-bar__group">
            <label htmlFor={namespaceId} className="kos-tm-command-bar__label">
              Namespace
            </label>
            <select
              id={namespaceId}
              className="kos-tm-command-bar__select"
              value={namespace === null ? 'all' : namespace}
              onChange={handleNamespaceChange}
            >
              <option value="all">All namespaces</option>
            </select>
          </div>
        )}

        {onUpdateSpeedChange !== undefined && (
          <div className="kos-tm-command-bar__group">
            <label htmlFor={speedId} className="kos-tm-command-bar__label">
              Speed
            </label>
            <select
              id={speedId}
              className="kos-tm-command-bar__select"
              value={updateSpeed ?? 'normal'}
              onChange={handleSpeedChange}
            >
              {SPEED_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>
        )}

        {onQueryChange !== undefined && (
          <div className="kos-tm-command-bar__search">
            <label htmlFor={searchId} className="kos-tm-command-bar__label sr-only">
              Search
            </label>
            <input
              id={searchId}
              type="search"
              className="kos-tm-command-bar__input"
              placeholder="Search..."
              value={query}
              onChange={handleSearchChange}
              aria-label="Search"
            />
          </div>
        )}
      </div>
    </div>
  );
}
