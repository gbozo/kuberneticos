import type { ReactNode } from 'react';

export type KosIconName =
  | 'folder'
  | 'start'
  | 'minimize'
  | 'maximize'
  | 'close'
  | 'restore'
  | 'settings'
  | 'calendar'
  | 'connect'
  | 'search'
  | 'terminal'
  | 'box'
  | 'server'
  | 'chevron-right'
  | 'activity'
  | 'menu'
  | 'chevron-down'
  | 'chevron-up'
  | 'graph'
  | 'memory'
  | 'disk'
  | 'network'
  | 'plug'
  | 'layers'
  | 'list'
  | 'refresh'
  | 'pause'
  | 'play'
  | 'sort-asc'
  | 'sort-desc'
  | 'cpu'
  | 'gauge'
  | 'container'
  | 'deployment'
  | 'replicaset'
  | 'pod'
  | 'x-circle';

export interface IconProps {
  name: KosIconName;
  size?: number;
  className?: string;
  onClick?: () => void;
  title?: string;
}

const ICONS: Record<KosIconName, ReactNode> = {
  folder: <path d="M3 6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6Z" />,
  start: (
    <>
      <path d="M3 3h8v8H3z" />
      <path d="M13 3h8v8h-8z" />
      <path d="M3 13h8v8H3z" />
      <path d="M13 13h8v8h-8z" />
    </>
  ),
  minimize: (
    <path d="M4 12h16" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" />
  ),
  maximize: <path d="M5 5h14v14H5z" fill="none" stroke="currentColor" strokeWidth={2} />,
  close: (
    <path
      d="M6 6l12 12M18 6 6 18"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
    />
  ),
  restore: (
    <>
      <path d="M9 4h11v11" fill="none" stroke="currentColor" strokeWidth={2} />
      <path d="M4 9h11v11H4z" fill="none" stroke="currentColor" strokeWidth={2} />
    </>
  ),
  settings: (
    <>
      <path
        d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="12" cy="12" r="3" fill="none" stroke="currentColor" strokeWidth={2} />
    </>
  ),
  calendar: (
    <>
      <rect
        x="3"
        y="5"
        width="18"
        height="16"
        rx="2"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
      />
      <path
        d="M3 10h18M8 3v4M16 3v4"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
      />
    </>
  ),
  connect: (
    <>
      <circle cx="5" cy="12" r="2.5" fill="none" stroke="currentColor" strokeWidth={2} />
      <circle cx="19" cy="12" r="2.5" fill="none" stroke="currentColor" strokeWidth={2} />
      <path d="M7.5 12h9" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" />
    </>
  ),
  search: (
    <>
      <circle cx="10.5" cy="10.5" r="6" fill="none" stroke="currentColor" strokeWidth={2} />
      <path
        d="M15 15l5 5"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
      />
    </>
  ),
  terminal: (
    <>
      <rect
        x="3"
        y="4"
        width="18"
        height="16"
        rx="2"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
      />
      <path
        d="M7 9l3 3-3 3M13 15h4"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </>
  ),
  box: (
    <>
      <path
        d="M12 3l8 4.5v9L12 21l-8-4.5v-9L12 3z"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinejoin="round"
      />
      <path
        d="M4 7.5l8 4.5 8-4.5M12 12v9"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinejoin="round"
      />
    </>
  ),
  server: (
    <>
      <rect
        x="3"
        y="4"
        width="18"
        height="6"
        rx="1.5"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
      />
      <rect
        x="3"
        y="14"
        width="18"
        height="6"
        rx="1.5"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
      />
      <path
        d="M7 7h.01M7 17h.01"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
      />
    </>
  ),
  'chevron-right': (
    <path
      d="M9 6l6 6-6 6"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  ),
  activity: (
    <path
      d="M22 12h-4l-3 9L9 3l-3 9H2"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  ),
  menu: (
    <path
      d="M4 7h16M4 12h16M4 17h16"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
    />
  ),
  'chevron-down': (
    <path
      d="M6 9l6 6 6-6"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  ),
  'chevron-up': (
    <path
      d="M6 15l6-6 6 6"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  ),
  graph: (
    <>
      <path
        d="M4 4v16h16"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M7 15l3.5-4 3 3L19 8"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </>
  ),
  memory: (
    <>
      <rect
        x="3"
        y="7"
        width="18"
        height="10"
        rx="1.5"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
      />
      <path
        d="M7 17v3M12 17v3M17 17v3M7 10v4M12 10v4M17 10v4"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        strokeLinecap="round"
      />
    </>
  ),
  disk: (
    <>
      <rect
        x="3"
        y="5"
        width="18"
        height="14"
        rx="2"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
      />
      <circle cx="8" cy="12" r="1.5" fill="currentColor" />
      <path
        d="M13 10h5M13 14h5"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
      />
    </>
  ),
  network: (
    <>
      <rect
        x="9"
        y="3"
        width="6"
        height="5"
        rx="1"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
      />
      <rect
        x="2"
        y="16"
        width="6"
        height="5"
        rx="1"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
      />
      <rect
        x="16"
        y="16"
        width="6"
        height="5"
        rx="1"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
      />
      <path d="M12 8v4M12 12H5v4M12 12h7v4" fill="none" stroke="currentColor" strokeWidth={2} />
    </>
  ),
  plug: (
    <>
      <path
        d="M9 3v5M15 3v5"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
      />
      <path
        d="M6 8h12v3a6 6 0 0 1-6 6 6 6 0 0 1-6-6V8z"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinejoin="round"
      />
      <path d="M12 17v4" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" />
    </>
  ),
  layers: (
    <>
      <path
        d="M12 3l9 5-9 5-9-5 9-5z"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinejoin="round"
      />
      <path
        d="M3 13l9 5 9-5"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinejoin="round"
      />
    </>
  ),
  list: (
    <>
      <path
        d="M8 6h13M8 12h13M8 18h13"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
      />
      <circle cx="4" cy="6" r="1.3" fill="currentColor" />
      <circle cx="4" cy="12" r="1.3" fill="currentColor" />
      <circle cx="4" cy="18" r="1.3" fill="currentColor" />
    </>
  ),
  refresh: (
    <>
      <path
        d="M20 11a8 8 0 1 0-2 5.3"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
      />
      <path
        d="M20 4v7h-7"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </>
  ),
  pause: (
    <>
      <rect x="6" y="5" width="4" height="14" rx="1" fill="currentColor" />
      <rect x="14" y="5" width="4" height="14" rx="1" fill="currentColor" />
    </>
  ),
  play: <path d="M7 5l12 7-12 7V5z" fill="currentColor" />,
  'sort-asc': (
    <>
      <path
        d="M12 19V5M6 11l6-6 6 6"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </>
  ),
  'sort-desc': (
    <>
      <path
        d="M12 5v14M6 13l6 6 6-6"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </>
  ),
  cpu: (
    <>
      <rect
        x="6"
        y="6"
        width="12"
        height="12"
        rx="1.5"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
      />
      <rect x="10" y="10" width="4" height="4" rx="0.5" fill="currentColor" />
      <path
        d="M9 3v3M15 3v3M9 18v3M15 18v3M3 9h3M3 15h3M18 9h3M18 15h3"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
      />
    </>
  ),
  gauge: (
    <>
      <path
        d="M4 18a8 8 0 1 1 16 0"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
      />
      <path
        d="M12 18l4-6"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
      />
      <circle cx="12" cy="18" r="1.5" fill="currentColor" />
    </>
  ),
  container: (
    <>
      <rect
        x="3"
        y="6"
        width="18"
        height="12"
        rx="1.5"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
      />
      <path d="M8 6v12M13 6v12M18 6v12" fill="none" stroke="currentColor" strokeWidth={1.5} />
    </>
  ),
  deployment: (
    <>
      <path
        d="M12 3l7 4v10l-7 4-7-4V7l7-4z"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinejoin="round"
      />
      <path d="M12 12v9M5 7l7 5 7-5" fill="none" stroke="currentColor" strokeWidth={2} />
    </>
  ),
  replicaset: (
    <>
      <rect
        x="3"
        y="5"
        width="8"
        height="14"
        rx="1.5"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
      />
      <rect
        x="13"
        y="5"
        width="8"
        height="14"
        rx="1.5"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
      />
    </>
  ),
  pod: (
    <path
      d="M12 3l8 4.5v9L12 21l-8-4.5v-9L12 3z"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinejoin="round"
    />
  ),
  'x-circle': (
    <>
      <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth={2} />
      <path
        d="M9 9l6 6M15 9l-6 6"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
      />
    </>
  ),
};

export function Icon({ name, size = 24, className, onClick, title }: IconProps) {
  const classes = className ? `kos-icon ${className}` : 'kos-icon';
  return (
    <svg
      className={classes}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      role="img"
      aria-label={title}
      aria-hidden={title ? undefined : true}
      focusable="false"
      fill="currentColor"
      stroke="none"
      onClick={onClick}
    >
      {title ? <title>{title}</title> : null}
      {ICONS[name]}
    </svg>
  );
}
