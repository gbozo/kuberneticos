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
	"io"
	"log"
	"net/http"
	"os"
	"os/signal"
	"sort"
	"strconv"
	"strings"
	"syscall"
	"time"

	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
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

	// Pod log streaming defaults and bounds for the tailLines query parameter.
	defaultTailLines = 200
	minTailLines     = 1
	maxTailLines     = 5000
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

// Replicas is the API-facing view of a workload's replica counts.
type Replicas struct {
	Desired   int32 `json:"desired"`
	Ready     int32 `json:"ready"`
	Available int32 `json:"available"`
	Updated   int32 `json:"updated"`
}

// Namespace is the API-facing view of a Kubernetes namespace.
type Namespace struct {
	Name   string `json:"name"`
	Status string `json:"status"`
}

// Deployment is the API-facing view of a Kubernetes deployment.
type Deployment struct {
	Name      string   `json:"name"`
	Namespace string   `json:"namespace"`
	Replicas  Replicas `json:"replicas"`
	Images    []string `json:"images"`
}

// ReplicaSet is the API-facing view of a Kubernetes replica set.
type ReplicaSet struct {
	Name      string   `json:"name"`
	Namespace string   `json:"namespace"`
	Replicas  Replicas `json:"replicas"`
}

// ReplicationController is the API-facing view of a replication controller.
type ReplicationController struct {
	Name      string   `json:"name"`
	Namespace string   `json:"namespace"`
	Replicas  Replicas `json:"replicas"`
}

// ServicePort is the API-facing view of a single service port.
type ServicePort struct {
	Name       string `json:"name"`
	Port       int32  `json:"port"`
	Protocol   string `json:"protocol"`
	TargetPort string `json:"targetPort"`
}

// Service is the API-facing view of a Kubernetes service.
type Service struct {
	Name      string        `json:"name"`
	Namespace string        `json:"namespace"`
	Type      string        `json:"type"`
	ClusterIP string        `json:"clusterIP"`
	Ports     []ServicePort `json:"ports"`
}

// NodeCondition is the API-facing view of a node condition.
type NodeCondition struct {
	Type   string `json:"type"`
	Status string `json:"status"`
}

// NodeAddress is the API-facing view of a node address.
type NodeAddress struct {
	Type    string `json:"type"`
	Address string `json:"address"`
}

// NodeDetail is the API-facing detailed view of a Kubernetes node.
type NodeDetail struct {
	Name        string            `json:"name"`
	Status      string            `json:"status"`
	Roles       []string          `json:"roles"`
	Version     string            `json:"version"`
	Capacity    map[string]string `json:"capacity"`
	Allocatable map[string]string `json:"allocatable"`
	Conditions  []NodeCondition   `json:"conditions"`
	Addresses   []NodeAddress     `json:"addresses"`
}

// ClusterClient is the single seam between HTTP handlers and the cluster.
type ClusterClient interface {
	ListClusters(ctx context.Context) ([]ClusterRef, error)
	ListNodes(ctx context.Context, clusterID string) ([]Node, error)
	ListPods(ctx context.Context, clusterID, node, namespace, selector string) ([]Pod, error)
	ListNamespaces(ctx context.Context, clusterID string) ([]Namespace, error)
	ListDeployments(ctx context.Context, clusterID, namespace string) ([]Deployment, error)
	ListReplicaSets(ctx context.Context, clusterID, namespace string) ([]ReplicaSet, error)
	ListReplicationControllers(ctx context.Context, clusterID, namespace string) ([]ReplicationController, error)
	ListServices(ctx context.Context, clusterID, namespace string) ([]Service, error)
	GetNode(ctx context.Context, clusterID, name string) (NodeDetail, error)
	PodLogs(ctx context.Context, clusterID, namespace, pod, container string, tailLines int) (string, error)
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

func (offlineClient) ListPods(context.Context, string, string, string, string) ([]Pod, error) {
	return []Pod{}, nil
}

func (offlineClient) ListNamespaces(context.Context, string) ([]Namespace, error) {
	return []Namespace{}, nil
}

func (offlineClient) ListDeployments(context.Context, string, string) ([]Deployment, error) {
	return []Deployment{}, nil
}

func (offlineClient) ListReplicaSets(context.Context, string, string) ([]ReplicaSet, error) {
	return []ReplicaSet{}, nil
}

func (offlineClient) ListReplicationControllers(context.Context, string, string) ([]ReplicationController, error) {
	return []ReplicationController{}, nil
}

func (offlineClient) ListServices(context.Context, string, string) ([]Service, error) {
	return []Service{}, nil
}

func (offlineClient) GetNode(context.Context, string, string) (NodeDetail, error) {
	return NodeDetail{
		Roles:       []string{},
		Capacity:    map[string]string{},
		Allocatable: map[string]string{},
		Conditions:  []NodeCondition{},
		Addresses:   []NodeAddress{},
	}, nil
}

func (offlineClient) PodLogs(context.Context, string, string, string, string, int) (string, error) {
	return "", nil
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

func (c *liveClient) ListPods(ctx context.Context, _, node, namespace, selector string) ([]Pod, error) {
	opts := metav1.ListOptions{}
	if node != "" {
		opts.FieldSelector = fields.OneTermEqualSelector("spec.nodeName", node).String()
	}
	if selector != "" {
		opts.LabelSelector = selector
	}

	ns := metav1.NamespaceAll
	if namespace != "" {
		ns = namespace
	}

	list, err := c.clientset.CoreV1().Pods(ns).List(ctx, opts)
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

func (c *liveClient) ListNamespaces(ctx context.Context, _ string) ([]Namespace, error) {
	list, err := c.clientset.CoreV1().Namespaces().List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, err
	}

	namespaces := make([]Namespace, 0, len(list.Items))
	for i := range list.Items {
		ns := &list.Items[i]
		namespaces = append(namespaces, Namespace{
			Name:   ns.Name,
			Status: string(ns.Status.Phase),
		})
	}
	return namespaces, nil
}

func (c *liveClient) ListDeployments(ctx context.Context, _, namespace string) ([]Deployment, error) {
	list, err := c.clientset.AppsV1().Deployments(namespace).List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, err
	}

	deployments := make([]Deployment, 0, len(list.Items))
	for i := range list.Items {
		d := &list.Items[i]
		images := make([]string, 0, len(d.Spec.Template.Spec.Containers))
		for j := range d.Spec.Template.Spec.Containers {
			images = append(images, d.Spec.Template.Spec.Containers[j].Image)
		}
		deployments = append(deployments, Deployment{
			Name:      d.Name,
			Namespace: d.Namespace,
			Replicas:  replicasFrom(d.Spec.Replicas, d.Status.ReadyReplicas, d.Status.AvailableReplicas, d.Status.UpdatedReplicas),
			Images:    images,
		})
	}
	return deployments, nil
}

func (c *liveClient) ListReplicaSets(ctx context.Context, _, namespace string) ([]ReplicaSet, error) {
	list, err := c.clientset.AppsV1().ReplicaSets(namespace).List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, err
	}

	replicaSets := make([]ReplicaSet, 0, len(list.Items))
	for i := range list.Items {
		rs := &list.Items[i]
		// ReplicaSetStatus has no "updated replicas" field (unlike Deployment),
		// so Updated is reported as 0 rather than reusing an unrelated counter.
		replicaSets = append(replicaSets, ReplicaSet{
			Name:      rs.Name,
			Namespace: rs.Namespace,
			Replicas: Replicas{
				Desired:   replicasValue(rs.Spec.Replicas),
				Ready:     rs.Status.ReadyReplicas,
				Available: rs.Status.AvailableReplicas,
				Updated:   0,
			},
		})
	}
	return replicaSets, nil
}

func (c *liveClient) ListReplicationControllers(ctx context.Context, _, namespace string) ([]ReplicationController, error) {
	list, err := c.clientset.CoreV1().ReplicationControllers(namespace).List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, err
	}

	controllers := make([]ReplicationController, 0, len(list.Items))
	for i := range list.Items {
		rc := &list.Items[i]
		// ReplicationControllerStatus has no field tracking how many replicas
		// run the latest template (unlike Deployment/ReplicaSet), so Updated is
		// reported as 0 rather than reusing an unrelated counter.
		controllers = append(controllers, ReplicationController{
			Name:      rc.Name,
			Namespace: rc.Namespace,
			Replicas: Replicas{
				Desired:   replicasValue(rc.Spec.Replicas),
				Ready:     rc.Status.ReadyReplicas,
				Available: rc.Status.AvailableReplicas,
				Updated:   0,
			},
		})
	}
	return controllers, nil
}

func (c *liveClient) ListServices(ctx context.Context, _, namespace string) ([]Service, error) {
	list, err := c.clientset.CoreV1().Services(namespace).List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, err
	}

	services := make([]Service, 0, len(list.Items))
	for i := range list.Items {
		svc := &list.Items[i]
		ports := make([]ServicePort, 0, len(svc.Spec.Ports))
		for j := range svc.Spec.Ports {
			p := &svc.Spec.Ports[j]
			ports = append(ports, ServicePort{
				Name:       p.Name,
				Port:       p.Port,
				Protocol:   string(p.Protocol),
				TargetPort: p.TargetPort.String(),
			})
		}
		services = append(services, Service{
			Name:      svc.Name,
			Namespace: svc.Namespace,
			Type:      string(svc.Spec.Type),
			ClusterIP: svc.Spec.ClusterIP,
			Ports:     ports,
		})
	}
	return services, nil
}

func (c *liveClient) GetNode(ctx context.Context, _, name string) (NodeDetail, error) {
	n, err := c.clientset.CoreV1().Nodes().Get(ctx, name, metav1.GetOptions{})
	if err != nil {
		return NodeDetail{}, err
	}

	conditions := make([]NodeCondition, 0, len(n.Status.Conditions))
	for i := range n.Status.Conditions {
		cond := &n.Status.Conditions[i]
		conditions = append(conditions, NodeCondition{
			Type:   string(cond.Type),
			Status: string(cond.Status),
		})
	}

	addresses := make([]NodeAddress, 0, len(n.Status.Addresses))
	for i := range n.Status.Addresses {
		addr := &n.Status.Addresses[i]
		addresses = append(addresses, NodeAddress{
			Type:    string(addr.Type),
			Address: addr.Address,
		})
	}

	return NodeDetail{
		Name:        n.Name,
		Status:      nodeStatus(n),
		Roles:       nodeRoles(n),
		Version:     n.Status.NodeInfo.KubeletVersion,
		Capacity:    quantityMap(n.Status.Capacity),
		Allocatable: quantityMap(n.Status.Allocatable),
		Conditions:  conditions,
		Addresses:   addresses,
	}, nil
}

func (c *liveClient) PodLogs(ctx context.Context, _, namespace, pod, container string, tailLines int) (string, error) {
	opts := &corev1.PodLogOptions{}
	if container != "" {
		opts.Container = container
	}
	if tailLines > 0 {
		n := int64(tailLines)
		opts.TailLines = &n
	}

	stream, err := c.clientset.CoreV1().Pods(namespace).GetLogs(pod, opts).Stream(ctx)
	if err != nil {
		return "", err
	}
	defer stream.Close()

	data, err := io.ReadAll(stream)
	if err != nil {
		return "", err
	}
	return string(data), nil
}

// replicasFrom builds a Replicas view from a desired pointer plus status counts.
func replicasFrom(desired *int32, ready, available, updated int32) Replicas {
	return Replicas{
		Desired:   replicasValue(desired),
		Ready:     ready,
		Available: available,
		Updated:   updated,
	}
}

// replicasValue dereferences an optional desired replica count (nil means 0).
func replicasValue(desired *int32) int32 {
	if desired == nil {
		return 0
	}
	return *desired
}

// quantityMap renders each resource.Quantity as its canonical string form.
func quantityMap(in corev1.ResourceList) map[string]string {
	out := make(map[string]string, len(in))
	for name, quantity := range in {
		out[string(name)] = quantity.String()
	}
	return out
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
	Pods   []Pod  `json:"pods"`
}

type namespacesResponse struct {
	Source     string      `json:"source"`
	Namespaces []Namespace `json:"namespaces"`
}

type deploymentsResponse struct {
	Source      string       `json:"source"`
	Deployments []Deployment `json:"deployments"`
}

type replicaSetsResponse struct {
	Source      string       `json:"source"`
	ReplicaSets []ReplicaSet `json:"replicasets"`
}

type replicationControllersResponse struct {
	Source                 string                  `json:"source"`
	ReplicationControllers []ReplicationController `json:"replicationcontrollers"`
}

type servicesResponse struct {
	Source   string    `json:"source"`
	Services []Service `json:"services"`
}

type nodeDetailResponse struct {
	Source string     `json:"source"`
	Node   NodeDetail `json:"node"`
}

type podLogsResponse struct {
	Source string `json:"source"`
	Logs   string `json:"logs"`
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

	pods, err := a.client.ListPods(r.Context(), query.Get("cluster"), query.Get("node"), query.Get("namespace"), query.Get("selector"))
	if err != nil {
		writeError(w, err)
		return
	}

	writeJSON(w, http.StatusOK, podsResponse{Source: a.source, Pods: pods})
}

func (a *api) handleNamespaces(w http.ResponseWriter, r *http.Request) {
	namespaces, err := a.client.ListNamespaces(r.Context(), r.URL.Query().Get("cluster"))
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, namespacesResponse{Source: a.source, Namespaces: namespaces})
}

func (a *api) handleDeployments(w http.ResponseWriter, r *http.Request) {
	query := r.URL.Query()

	deployments, err := a.client.ListDeployments(r.Context(), query.Get("cluster"), query.Get("namespace"))
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, deploymentsResponse{Source: a.source, Deployments: deployments})
}

func (a *api) handleReplicaSets(w http.ResponseWriter, r *http.Request) {
	query := r.URL.Query()

	replicaSets, err := a.client.ListReplicaSets(r.Context(), query.Get("cluster"), query.Get("namespace"))
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, replicaSetsResponse{Source: a.source, ReplicaSets: replicaSets})
}

func (a *api) handleReplicationControllers(w http.ResponseWriter, r *http.Request) {
	query := r.URL.Query()

	controllers, err := a.client.ListReplicationControllers(r.Context(), query.Get("cluster"), query.Get("namespace"))
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, replicationControllersResponse{Source: a.source, ReplicationControllers: controllers})
}

func (a *api) handleServices(w http.ResponseWriter, r *http.Request) {
	query := r.URL.Query()

	services, err := a.client.ListServices(r.Context(), query.Get("cluster"), query.Get("namespace"))
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, servicesResponse{Source: a.source, Services: services})
}

func (a *api) handleNodeDetail(w http.ResponseWriter, r *http.Request) {
	query := r.URL.Query()

	name := query.Get("name")
	if name == "" {
		writeJSON(w, http.StatusBadRequest, errorResponse{Error: "missing required query parameter: name"})
		return
	}

	node, err := a.client.GetNode(r.Context(), query.Get("cluster"), name)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, nodeDetailResponse{Source: a.source, Node: node})
}

func (a *api) handlePodLogs(w http.ResponseWriter, r *http.Request) {
	query := r.URL.Query()

	tailLines := defaultTailLines
	if raw := query.Get("tailLines"); raw != "" {
		n, err := strconv.Atoi(raw)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, errorResponse{Error: "invalid tailLines"})
			return
		}
		tailLines = n
	}
	if tailLines < minTailLines {
		tailLines = minTailLines
	}
	if tailLines > maxTailLines {
		tailLines = maxTailLines
	}

	logs, err := a.client.PodLogs(r.Context(), query.Get("cluster"), query.Get("namespace"), query.Get("pod"), query.Get("container"), tailLines)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, podLogsResponse{Source: a.source, Logs: logs})
}

// newMux wires the method-aware routes (Go 1.22+ patterns).
func newMux(a *api) *http.ServeMux {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/health", a.handleHealth)
	mux.HandleFunc("GET /api/clusters", a.handleClusters)
	mux.HandleFunc("GET /api/nodes", a.handleNodes)
	mux.HandleFunc("GET /api/nodes/detail", a.handleNodeDetail)
	mux.HandleFunc("GET /api/pods", a.handlePods)
	mux.HandleFunc("GET /api/pods/logs", a.handlePodLogs)
	mux.HandleFunc("GET /api/namespaces", a.handleNamespaces)
	mux.HandleFunc("GET /api/deployments", a.handleDeployments)
	mux.HandleFunc("GET /api/replicasets", a.handleReplicaSets)
	mux.HandleFunc("GET /api/replicationcontrollers", a.handleReplicationControllers)
	mux.HandleFunc("GET /api/services", a.handleServices)
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
	status := http.StatusInternalServerError
	if apierrors.IsNotFound(err) {
		status = http.StatusNotFound
	}
	writeJSON(w, status, errorResponse{Error: err.Error()})
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
