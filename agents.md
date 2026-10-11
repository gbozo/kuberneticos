# agents.md — KuberneticOS

Instructions for AI agents working in this repository. Read `spec.md` for the
project specification; this file tells agents how to navigate and change the
codebase safely.

## What this project is

KuberneticOS is a **web desktop for Kubernetes**: a browser application that
mimics a real desktop environment (Windows-style taskbar, start menu,
context menu, resizable windows, focus/blur semantics) whose "applications"
manage Kubernetes clusters (nodes, pods, Helm-style package management,
task-manager drill-downs). The Windows resemblance is intentional and must be
preserved.

## Repository layout

| Path | What it is | Agent guidance |
|---|---|---|
| `src/` (JS files) | The frontend app: taskbar, start menu, window manager, window apps | Primary code. Currently legacy Flow-syntax React 16 — see `spec.md` for the modernization target. |
| `src/github.com/gbozo/kuberneticos/` | ~2,200 vendored Go files: the **deprecated** `kubernetes-client/go` library (pre-2018) | Do **not** edit these files piecemeal. They are a vendor drop, not hand-written project code. See decision D1 in `spec.md`. |
| `src/assets/` | Logos, wallpapers, CSS | Keep; prefer SVG, compress raster assets. |
| `public/`, `styleguide/` | CRA-era leftovers (favicon, manifest, built styleguide output) | Regenerate with modern tooling; do not hand-edit build output. |
| `README.md`, `help.md` | Docs | `help.md` is the stale CRA 2.x boilerplate — replace, don't patch. |
| `gulpfile.babel.js`, `.babelrc`, `.flowconfig` | Legacy build tooling | Remove as part of modernization (decision D3). |

## Hard rules for agents

1. **Never "fix" the vendored Go tree** by patching individual files. If it
   stays (decision D1 pending), treat it as read-only vendor data; if it goes,
   delete the whole subtree in one change.
2. The frontend source uses **Flow syntax** (`import * as React from "react"`,
   `import X from "y"`, `const Foo: Type = ...`). This is not valid JavaScript
   and will not parse under modern Babel/TS. When modernizing, convert to
   TypeScript ES modules — do not attempt incremental syntax fixes.
3. Preserve the **desktop metaphor**: taskbar fixed at bottom, z-index layering
   (taskbar above windows), focus/blur window states, minimize/restore, start
   menu opening above the taskbar, right-click context menu. These behaviors
   are the product's core spec (see `spec.md` §Behavior contract).
4. Kubernetes integration is currently aspirational (the JS app has no live
   cluster connection). Any new cluster connection must go through a typed
   client layer, never ad-hoc `fetch` calls scattered in components.
5. Keep the GPL-3 license and the existing `FUNDING.yml` untouched.

## Commands (modern target)

After modernization (decisions D2/D3 applied), agents should use:

```
npm run build          # vite build
npm run dev            # vite dev server
npm run test           # vitest (unit) + playwright (e2e)
npm run lint           # eslint 9 (flat config)
npm run format:check   # prettier
```

Before modernization, the old `yarn start` / gulp commands still exist but are
considered deprecated; do not extend them.

## Code style (target)

- TypeScript strict mode; no `any` at public boundaries.
- Modern React (19.x): `use` hooks (`useEffect`, `useEvent`-style patterns),
  no `component`-class boilerplate; prefer composition over `extends
  React.Component`.
- No `console.log` for state tracing — use a debug flag or the browser
  console behind a `DEBUG` gate.
- CSS lives in one themed stylesheet with design tokens (CSS custom
  properties) so the Windows/MacOS/Gnome skins from the README roadmap are
  swappable themes, not forks.
- IDs: `crypto.randomUUID()` (no `shortid`).
- State: plain immutable state + explicit event bus only where cross-component
  observation is needed (window focus, store listeners) — see `spec.md` §State.

## Gotchas

- `react-uwp` is abandoned (last release ~2018, incompatible with React 19).
  Its widgets (`AppBarButton`, `Menu`, `Toggle`, `Icon`, …) must be replaced
  with small local components + CSS (decision D4).
- `react-rnd` is still maintained and may be kept, or replaced with a small
  custom drag/resize implementation (decision D5).
- The old Flux layer (`flux` npm package + Node `events` EventEmitter) predates
  React's current idioms; it is specified to be replaced, not upgraded
  (`spec.md` §State).
- The README badge links point at a different repo (`kylelobo/The-Documentation-Compendium`) — fix when touching README.
