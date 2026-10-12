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
  | 'activity';

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
