# agents.md — KuberneticOS

Instructions for AI agents working in this repository. Read `spec.md` for the
project specification; this file tells agents how to navigate and change the
codebase safely.

The modernization described in `spec.md` is **complete**: the app is TypeScript
+ React 19 + Vite, the Go server is live, and the legacy Flow sources, CRA
tooling, and vendored Go tree are gone. This file describes the code that is
actually here.

## What this project is

KuberneticOS is a **web desktop for Kubernetes**: a browser application that
mimics a real desktop environment (Windows-style taskbar, start menu,
context menu, resizable windows, focus/blur semantics) whose "applications"
manage Kubernetes clusters. The Windows resemblance is intentional and must be
preserved.

## Repository layout

| Path | What it is | Agent guidance |
|---|---|---|
| `src/` | The frontend app (TypeScript, React 19) | Primary code. |
| `src/state/` | Desktop state model: `types.ts` (state + action unions), `reducer.ts` (pure reducer + selectors), `events.ts` (typed event bus), `DesktopContext.tsx` (provider + `useDesktop`/`useDesktopEvent`) | Change behavior here first, with a unit test. |
| `src/components/` | Desktop shell (`Window`, `WindowApp`, `WindowManager`, `TaskBar`, `TaskBarWindows`, `TaskBarClock`, `StartMenu`, `Contextmenu`) + one CSS file each | Keep the desktop metaphor (rule 2). |
| `src/components/ui/` | Local UI primitives that replaced `react-uwp` (`AppBarButton`, `Menu`, `Toggle`, `Icon`, `Tooltip`, `ListView`, …) + `ui.css` | Reuse these; do **not** add a UI-kit dependency. |
| `src/theme/` | `tokens.css` design tokens + per-theme overrides, `theme.ts` (apply/persist) | All colours and sizes go through `--kos-*` tokens. |
| `src/window-apps/` | Pluggable window "apps" (`TestWindow`, `ClusterExplorer`, `TaskManager`) and `registry.ts` | Register new apps in the registry. |
| `src/cluster/client.ts` | **The one** cluster integration point: the `ClusterClient` interface, `HttpClusterClient`, `OfflineClusterClient` | No `fetch` outside this file (rule 1). |
| `src/assets/` | Logos and wallpapers | Keep; prefer SVG, compress raster assets. |
| `server/` | Go API server (`k8s.io/client-go`) serving JSON under `/api` | See `server/README.md`. |
| `e2e/` | Playwright specs | The desktop behaviour contract is asserted here. |
| `README.md`, `spec.md`, `agents.md` | Docs | Keep them truthful when you change behaviour. |

## Hard rules for agents

1. **`fetch` lives only in `src/cluster/client.ts`.** Components and window apps
   call the typed `ClusterClient` interface (`clusterClient`); never add ad-hoc
   `fetch` calls elsewhere.
2. **Preserve the desktop metaphor**: taskbar fixed at the bottom, z-index
   layering (taskbar above windows), focus/blur window states, minimize/restore
   distinct from close, start menu opening above the taskbar, right-click
   context menu, ticking clock. These are the product's core spec
   (`spec.md` §Behaviour contract) and are covered by `e2e/desktop.spec.ts`.
3. **State changes go through the reducer.** Add an action to the
   `DesktopAction` union in `src/state/types.ts` and a case in
   `src/state/reducer.ts`; keep `desktopReducer` pure and immutable. Only use the
   event bus (`src/state/events.ts`) where cross-component observation is
   genuinely needed.
4. **Server-side cluster access uses `k8s.io/client-go`** — never the archived
   `github.com/kubernetes-client/go`. Build the client so it degrades to
   `offlineClient` rather than failing to start.
5. Keep the GPL-3 `LICENSE` and the existing `.github/FUNDING.yml` untouched.

## Commands

```
npm install            # once
npm run dev            # vite dev server → http://localhost:5173
npm run build          # tsc -b && vite build
npm run preview        # serve the production build
npm run test           # vitest run (unit)
npm run test:watch     # vitest (watch)
npm run e2e            # playwright test
npm run lint           # eslint . (flat config)
npm run format         # prettier --write .
npm run format:check   # prettier --check .
```

The Go server runs separately:

```
cd server && go run .            # listens on :8700 (PORT env)
```

In development Vite proxies `/api` → `http://localhost:8700`, so run both. With
no kubeconfig the server stays up and answers `{"source":"offline", ...}` with
empty lists — the frontend then shows *"No clusters configured — start the Go
server"* in Cluster Explorer and Task Manager.

## Code style

- TypeScript strict mode; no `any` at public boundaries.
- Modern React: function components and hooks only; no class components.
- IDs: `crypto.randomUUID()` (no `shortid`).
- Imports are relative and typed (`import type { … }` for types).
- No `console.log` for state tracing — use a `DEBUG`-gated log.
- CSS lives in the per-component files plus `src/theme/tokens.css`; themes
  (windows/macos/gnome/kde) are token overrides, not forks.
- `npx prettier --write .` before finishing (config: single quotes, semicolons,
  printWidth 100, trailing commas).

## Gotchas

- `react-uwp` is gone on purpose — replace-or-add none. Use `src/components/ui/`.
- `react-rnd` is kept deliberately (decision D5) and drives window
  drag/resize; `Window.tsx` derives maximized geometry from the viewport.
- `vite.config.ts` pins the vitest `include` to `src/**/*.{test,spec}.{ts,tsx}`
  so vitest does not try to run the Playwright specs in `e2e/`. Do not remove
  that narrowing.
- Playwright needs its browser once: `npx playwright install chromium`.
- `eslint` reports two accepted `react-refresh/only-export-components`
  warnings for `src/state/DesktopContext.tsx` (provider + hooks in one file);
  these are expected, not a regression.
- `server/go.mod` carries `toolchain go1.26.9`; the first `go build` in
  `server/` downloads that toolchain (standard `GOTOOLCHAIN=auto`). This keeps
  `govulncheck` clean — do not downgrade it.
- `_config.yml` (jekyll-theme-architect) is a leftover kept deliberately; it is
  not part of the build.
