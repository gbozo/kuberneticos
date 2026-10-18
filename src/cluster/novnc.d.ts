// Ambient types for `@novnc/novnc` 1.x. The package ships no type definitions
// of its own (post-1.4 it exposes only `core/rfb.js` through its `exports`
// map), so we declare the surface kOS uses here. Extension: keep adding real
// members with real types — never widen to `any`.
declare module '@novnc/novnc' {
  export interface RfbCredentials {
    username?: string;
    password?: string;
    target?: string;
  }

  export interface RfbOptions {
    shared?: boolean;
    credentials?: RfbCredentials;
    repeaterID?: string;
    wsProtocols?: string[];
  }

  export default class RFB extends EventTarget {
    constructor(target: HTMLElement, url: string, options?: RfbOptions);

    scaleViewport: boolean;
    resizeSession: boolean;
    viewOnly: boolean;

    disconnect(): void;
    clipboardPasteFrom(text: string): void;

    addEventListener(
      type: 'connect',
      listener: (event: CustomEvent<Record<string, never>>) => void,
    ): void;
    addEventListener(
      type: 'disconnect',
      listener: (event: CustomEvent<{ clean?: boolean }>) => void,
    ): void;
    addEventListener(
      type: 'credentialsrequired',
      listener: (event: CustomEvent<{ types: string[] }>) => void,
    ): void;
    addEventListener(
      type: 'securityfailure',
      listener: (event: CustomEvent<{ status: number; reason?: string }>) => void,
    ): void;
    addEventListener(
      type: 'clipboard',
      listener: (event: CustomEvent<{ text: string }>) => void,
    ): void;
    addEventListener(
      type: 'desktopname',
      listener: (event: CustomEvent<{ name: string }>) => void,
    ): void;
    addEventListener(type: string, listener: (event: CustomEvent) => void): void;
    addEventListener(
      type: string,
      listener: EventListenerOrEventListenerObject | null,
      options?: boolean | AddEventListenerOptions,
    ): void;
    removeEventListener(type: string, listener: EventListenerOrEventListenerObject | null): void;
  }
}
