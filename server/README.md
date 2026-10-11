# KuberneticOS API server

A small, stdlib-only Go HTTP server that exposes a JSON API for the
KuberneticOS web desktop (clusters, nodes, pods). It replaces the deleted
vendored `kubernetes-client/go` library with the modern, maintained
[`k8s.io/client-go`](https://github.com/kubernetes/client-go).

Cluster access follows the standard client-go loading order:

1. `KUBERNETICOS_KUBECONFIG` (falling back to `KUBECONFIG`)
2. in-cluster configuration (service account)
3. `$HOME/.kube/config`

If none of these can be loaded, the server **still starts** and serves explicit
offline responses with `"source":"offline"` and empty lists (`[]`), rather than
crashing.

## Run

```sh
cd server
go run .
```

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `8700` | HTTP listen port |
| `KUBERNETICOS_KUBECONFIG` | — | Explicit kubeconfig path (takes precedence over `KUBECONFIG`) |
| `KUBECONFIG` | — | Standard kubeconfig path, used if `KUBERNETICOS_KUBECONFIG` is unset |

## Endpoints

All responses are JSON and CORS-enabled (`Access-Control-Allow-Origin: *`).

| Method | Path | Response |
|---|---|---|
| `GET` | `/api/health` | `{"status":"ok","source":"live"\|"offline"}` |
| `GET` | `/api/clusters` | `{"source":..., "clusters":[ClusterRef...]}` |
| `GET` | `/api/nodes?cluster=<id>` | `{"source":..., "nodes":[Node...]}` |
| `GET` | `/api/pods?cluster=<id>&node=<name>&namespace=<ns>` | `{"source":..., "pods":[Pod...]}` |

Errors are returned as `500` with a `{"error":"..."}` body. Unknown methods on a
known path return `405`; `OPTIONS` is answered by the CORS middleware with `204`.

### Types

```jsonc
// ClusterRef
{ "id": "...", "name": "...", "server": "https://..." }

// Node
{ "name": "...", "status": "Ready", "roles": ["control-plane"], "version": "v1.30.0" }

// Pod
{ "name": "...", "namespace": "...", "node": "...", "phase": "Running" }
```

## Frontend integration

The repo's `vite.config.ts` proxies `/api` to `http://localhost:8700`, so the
web desktop can call these endpoints during `vite dev` without CORS setup.
