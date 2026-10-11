// Command server is the JSON API backend for the KuberneticOS web desktop.
//
// It intentionally keeps a small, fully typed internal layer: handlers never
// touch Kubernetes objects or unstructured maps directly, they only call the
// ClusterClient interface. When no Kubernetes configuration is available the
// server still starts and serves explicit offline responses.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"os"
	"os/signal"
	"sort"
	"strings"
	"syscall"
	"time"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/fields"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"
	"k8s.io/client-go/tools/clientcmd"
)

const (
	defaultPort = "8700"
	// offlineSource and liveSource are the only two values ever reported in a
	// response's "source" field.
	offlineSource = "offline"
	liveSource    = "live"

	shutdownTimeout = 5 * time.Second
)

// ClusterRef is a lightweight identity for a reachable cluster.
type ClusterRef struct {
	ID     string `json:"id"`
	Name   string `json:"name"`
	Server string `json:"server"`
}

// Node is the API-facing view of a Kubernetes node.
type Node struct {
	Name    string   `json:"name"`
	Status  string   `json:"status"`
	Roles   []string `json:"roles"`
	Version string   `json:"version"`
}

// Pod is the API-facing view of a Kubernetes pod.
type Pod struct {
	Name      string `json:"name"`
	Namespace string `json:"namespace"`
	Node      string `json:"node"`
	Phase     string `json:"phase"`
}

// ClusterClient is the single seam between HTTP handlers and the cluster.
type ClusterClient interface {
	ListClusters(ctx context.Context) ([]ClusterRef, error)
	ListNodes(ctx context.Context, clusterID string) ([]Node, error)
	ListPods(ctx context.Context, clusterID, node string) ([]Pod, error)
}

// offlineClient is used whenever no Kubernetes configuration could be loaded.
// It never errors and always returns non-nil empty slices so the API renders
// "[]" rather than "null".
type offlineClient struct{}

func (offlineClient) ListClusters(context.Context) ([]ClusterRef, error) {
	return []ClusterRef{}, nil
}

func (offlineClient) ListNodes(context.Context, string) ([]Node, error) {
	return []Node{}, nil
}

func (offlineClient) ListPods(context.Context, string, string) ([]Pod, error) {
	return []Pod{}, nil
}

// liveClient talks to a real cluster through a client-go clientset.
type liveClient struct {
	clientset   kubernetes.Interface
	clusterID   string
	clusterName string
	server      string
}

func (c *liveClient) ListClusters(context.Context) ([]ClusterRef, error) {
	return []ClusterRef{{
		ID:     c.clusterID,
		Name:   c.clusterName,
		Server: c.server,
	}}, nil
}

func (c *liveClient) ListNodes(ctx context.Context, _ string) ([]Node, error) {
	list, err := c.clientset.CoreV1().Nodes().List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, err
	}

	nodes := make([]Node, 0, len(list.Items))
	for i := range list.Items {
		n := &list.Items[i]
		nodes = append(nodes, Node{
			Name:    n.Name,
			Status:  nodeStatus(n),
			Roles:   nodeRoles(n),
			Version: n.Status.NodeInfo.KubeletVersion,
		})
	}
	return nodes, nil
}

func (c *liveClient) ListPods(ctx context.Context, _, node string) ([]Pod, error) {
	opts := metav1.ListOptions{}
	if node != "" {
		opts.FieldSelector = fields.OneTermEqualSelector("spec.nodeName", node).String()
	}

	list, err := c.clientset.CoreV1().Pods(metav1.NamespaceAll).List(ctx, opts)
	if err != nil {
		return nil, err
	}

	pods := make([]Pod, 0, len(list.Items))
	for i := range list.Items {
		p := &list.Items[i]
		pods = append(pods, Pod{
			Name:      p.Name,
			Namespace: p.Namespace,
			Node:      p.Spec.NodeName,
			Phase:     string(p.Status.Phase),
		})
	}
	return pods, nil
}

// nodeStatus derives a human-readable status from the node's Ready condition.
func nodeStatus(n *corev1.Node) string {
	for _, cond := range n.Status.Conditions {
		if cond.Type != corev1.NodeReady {
			continue
		}
		if cond.Status == corev1.ConditionTrue {
			return "Ready"
		}
		return "NotReady"
	}
	return "Unknown"
}

// nodeRoles extracts roles from the node-role.kubernetes.io/* labels.
func nodeRoles(n *corev1.Node) []string {
	const prefix = "node-role.kubernetes.io/"

	roles := []string{}
	for key := range n.Labels {
		if !strings.HasPrefix(key, prefix) {
			continue
		}
		if role := strings.TrimPrefix(key, prefix); role != "" {
			roles = append(roles, role)
		}
	}
	sort.Strings(roles)
	return roles
}

// Response payloads. Handlers only ever encode these typed structs.
type healthResponse struct {
	Status string `json:"status"`
	Source string `json:"source"`
}

type clustersResponse struct {
	Source   string       `json:"source"`
	Clusters []ClusterRef `json:"clusters"`
}

type nodesResponse struct {
	Source string `json:"source"`
	Nodes  []Node `json:"nodes"`
}

type podsResponse struct {
	Source string `json:"source"`
	Pods   []Pod `json:"pods"`
}

type errorResponse struct {
	Error string `json:"error"`
}

// api holds the dependencies shared by all handlers.
type api struct {
	client ClusterClient
	source string
}

func (a *api) handleHealth(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, healthResponse{Status: "ok", Source: a.source})
}

func (a *api) handleClusters(w http.ResponseWriter, r *http.Request) {
	clusters, err := a.client.ListClusters(r.Context())
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, clustersResponse{Source: a.source, Clusters: clusters})
}

func (a *api) handleNodes(w http.ResponseWriter, r *http.Request) {
	nodes, err := a.client.ListNodes(r.Context(), r.URL.Query().Get("cluster"))
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, nodesResponse{Source: a.source, Nodes: nodes})
}

func (a *api) handlePods(w http.ResponseWriter, r *http.Request) {
	query := r.URL.Query()

	pods, err := a.client.ListPods(r.Context(), query.Get("cluster"), query.Get("node"))
	if err != nil {
		writeError(w, err)
		return
	}

	if ns := query.Get("namespace"); ns != "" {
		filtered := make([]Pod, 0, len(pods))
		for _, p := range pods {
			if p.Namespace == ns {
				filtered = append(filtered, p)
			}
		}
		pods = filtered
	}

	writeJSON(w, http.StatusOK, podsResponse{Source: a.source, Pods: pods})
}

// newMux wires the method-aware routes (Go 1.22+ patterns).
func newMux(a *api) *http.ServeMux {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/health", a.handleHealth)
	mux.HandleFunc("GET /api/clusters", a.handleClusters)
	mux.HandleFunc("GET /api/nodes", a.handleNodes)
	mux.HandleFunc("GET /api/pods", a.handlePods)
	return mux
}

func writeJSON(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(payload); err != nil {
		log.Printf("encode response: %v", err)
	}
}

func writeError(w http.ResponseWriter, err error) {
	writeJSON(w, http.StatusInternalServerError, errorResponse{Error: err.Error()})
}

// withCORS allows the Vite dev server (and any other origin) to call the API.
func withCORS(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization")

		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// withLogging emits one minimal line per request to stderr.
func withLogging(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		next.ServeHTTP(w, r)
		log.Printf("%s %s %s", r.Method, r.URL.RequestURI(), time.Since(start).Round(time.Millisecond))
	})
}

// kubeSetup is the resolved client-go configuration plus a display name.
type kubeSetup struct {
	cfg  *rest.Config
	name string
}

// kubeconfigPath returns the explicitly configured kubeconfig path, if any.
func kubeconfigPath() string {
	if p := os.Getenv("KUBERNETICOS_KUBECONFIG"); p != "" {
		return p
	}
	return os.Getenv("KUBECONFIG")
}

// loadKubeSetup follows the standard client-go loading order:
// KUBERNETICOS_KUBECONFIG (fallback KUBECONFIG), in-cluster, then ~/.kube/config.
func loadKubeSetup() (*kubeSetup, error) {
	if path := kubeconfigPath(); path != "" {
		cfg, err := clientcmd.BuildConfigFromFlags("", path)
		if err != nil {
			log.Printf("kubeconfig %q unusable: %v", path, err)
		} else {
			return &kubeSetup{cfg: cfg, name: kubeContextName(path)}, nil
		}
	}

	if cfg, err := rest.InClusterConfig(); err != nil {
		log.Printf("in-cluster config unavailable: %v", err)
	} else {
		return &kubeSetup{cfg: cfg, name: "in-cluster"}, nil
	}

	if cfg, err := clientcmd.BuildConfigFromFlags("", clientcmd.RecommendedHomeFile); err != nil {
		log.Printf("kubeconfig %q unusable: %v", clientcmd.RecommendedHomeFile, err)
	} else {
		return &kubeSetup{cfg: cfg, name: kubeContextName(clientcmd.RecommendedHomeFile)}, nil
	}

	return nil, errors.New("no usable kubernetes configuration")
}

// kubeContextName reads the current context from a kubeconfig file for display.
func kubeContextName(path string) string {
	raw, err := clientcmd.LoadFromFile(path)
	if err != nil || raw.CurrentContext == "" {
		return "default"
	}
	return raw.CurrentContext
}

// buildClient returns a live cluster client when configuration is available and
// an offline client otherwise. It never fails.
func buildClient() (ClusterClient, string) {
	setup, err := loadKubeSetup()
	if err != nil {
		log.Printf("kubernetes unavailable, serving offline: %v", err)
		return offlineClient{}, offlineSource
	}

	clientset, err := kubernetes.NewForConfig(setup.cfg)
	if err != nil {
		log.Printf("kubernetes client init failed, serving offline: %v", err)
		return offlineClient{}, offlineSource
	}

	return &liveClient{
		clientset:   clientset,
		clusterID:   setup.name,
		clusterName: setup.name,
		server:      setup.cfg.Host,
	}, liveSource
}

func main() {
	log.SetOutput(os.Stderr)
	log.SetFlags(log.LstdFlags)

	port := os.Getenv("PORT")
	if port == "" {
		port = defaultPort
	}

	client, source := buildClient()
	handler := withLogging(withCORS(newMux(&api{client: client, source: source})))

	srv := &http.Server{
		Addr:              ":" + port,
		Handler:           handler,
		ReadHeaderTimeout: 10 * time.Second,
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	go func() {
		log.Printf("kuberneticos server listening on :%s (source=%s)", port, source)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Printf("server error: %v", err)
			stop()
		}
	}()

	<-ctx.Done()
	log.Println("shutting down")

	shutdownCtx, cancel := context.WithTimeout(context.Background(), shutdownTimeout)
	defer cancel()

	if err := srv.Shutdown(shutdownCtx); err != nil {
		log.Printf("graceful shutdown failed: %v", err)
	}
	log.Println("server stopped")
}
