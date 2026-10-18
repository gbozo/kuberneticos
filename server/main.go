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
	"fmt"
	"io"
	"log"
	"net/http"
	urlpkg "net/url"
	"os"
	"os/signal"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	autoscalingv1 "k8s.io/api/autoscaling/v1"
	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/fields"
	types "k8s.io/apimachinery/pkg/types"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"
	"k8s.io/client-go/tools/clientcmd"
	metricsv1beta1 "k8s.io/metrics/pkg/client/clientset/versioned"
)

const (
	defaultPort = "8700"
	// offlineSource and liveSource are the only two values ever reported in a
	// response's "source" field.
	offlineSource = "offline"
	liveSource    = "live"

	shutdownTimeout = 5 * time.Second

	// requestTimeout is the server-side budget for every HTTP request;
	// summaryCallTimeout is the per-node budget for one kubelet stats/summary
	// call, taken from the request budget with summaryFetchConcurrency nodes
	// in flight so an unresponsive kubelet cannot stall an endpoint.
	requestTimeout          = 15 * time.Second
	summaryCallTimeout      = 3 * time.Second
	summaryFetchConcurrency = 4

	// Pod log streaming defaults and bounds for the tailLines query parameter.
	defaultTailLines = 200
	minTailLines     = 1
	maxTailLines     = 5000

	// maxScaleReplicas bounds the scale action so a typo cannot ask for an absurd
	// number of pods. Kubernetes itself has no such limit.
	maxScaleReplicas = 1000

	// maxK8sNameLength is the RFC 1123 DNS label limit enforced by isK8sName.
	maxK8sNameLength = 63
)

// errOffline is returned by offlineClient for actions that require a cluster.
var errOffline = errors.New("offline: no Kubernetes cluster is configured")

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
	Name        string            `json:"name"`
	Namespace   string            `json:"namespace"`
	Node        string            `json:"node"`
	Phase       string            `json:"phase"`
	OwnerKind   string            `json:"ownerKind,omitempty"`
	OwnerName   string            `json:"ownerName,omitempty"`
	Labels      map[string]string `json:"labels,omitempty"`
	Annotations map[string]string `json:"annotations,omitempty"`
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
	OwnerKind string   `json:"ownerKind,omitempty"`
	OwnerName string   `json:"ownerName,omitempty"`
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
	Name      string            `json:"name"`
	Namespace string            `json:"namespace"`
	Type      string            `json:"type"`
	ClusterIP string            `json:"clusterIP"`
	Ports     []ServicePort     `json:"ports"`
	Selector  map[string]string `json:"selector,omitempty"`
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

// ContainerMetrics is the API-facing view of a single container's live usage.
type ContainerMetrics struct {
	Name        string `json:"name"`
	CPUMillis   int64  `json:"cpuMillis"`
	MemoryBytes int64  `json:"memoryBytes"`
}

// NodeMetrics is the API-facing view of live node resource usage.
type NodeMetrics struct {
	Name                   string `json:"name"`
	CPUMillis              int64  `json:"cpuMillis"`
	MemoryBytes            int64  `json:"memoryBytes"`
	CPUAllocatableMillis   int64  `json:"cpuAllocatableMillis,omitempty"`
	MemoryAllocatableBytes int64  `json:"memoryAllocatableBytes,omitempty"`
	DiskUsedBytes          int64  `json:"diskUsedBytes,omitempty"`
	DiskCapacityBytes      int64  `json:"diskCapacityBytes,omitempty"`
	NetworkRxBytes         int64  `json:"networkRxBytes,omitempty"`
	NetworkTxBytes         int64  `json:"networkTxBytes,omitempty"`
	PodCount               int32  `json:"podCount,omitempty"`
}

// PodMetrics is the API-facing view of live pod resource usage.
type PodMetrics struct {
	Name           string             `json:"name"`
	Namespace      string             `json:"namespace"`
	Node           string             `json:"node,omitempty"`
	CPUMillis      int64              `json:"cpuMillis"`
	MemoryBytes    int64              `json:"memoryBytes"`
	Containers     []ContainerMetrics `json:"containers"`
	DiskUsedBytes  int64              `json:"diskUsedBytes,omitempty"`
	NetworkRxBytes int64              `json:"networkRxBytes,omitempty"`
	NetworkTxBytes int64              `json:"networkTxBytes,omitempty"`
}

// NodeMetricsResult carries node metrics plus their availability.
type NodeMetricsResult struct {
	Available bool          `json:"available"`
	Nodes     []NodeMetrics `json:"nodes"`
}

// PodMetricsResult carries pod metrics plus their availability.
type PodMetricsResult struct {
	Available bool         `json:"available"`
	Pods      []PodMetrics `json:"pods"`
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
	GetNodeMetrics(ctx context.Context, clusterID string) (NodeMetricsResult, error)
	GetPodMetrics(ctx context.Context, clusterID, namespace string) (PodMetricsResult, error)
	DeletePod(ctx context.Context, clusterID, namespace, pod string) error
	RestartDeployment(ctx context.Context, clusterID, namespace, deployment string) error
	ScaleDeployment(ctx context.Context, clusterID, namespace, deployment string, replicas int32) error
}

// offlineClient is used whenever no Kubernetes configuration could be loaded.
// Read endpoints never error and always return non-nil empty slices so the API
// renders "[]" rather than "null"; mutating actions return errOffline.
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

func (offlineClient) GetNodeMetrics(context.Context, string) (NodeMetricsResult, error) {
	return NodeMetricsResult{Available: false, Nodes: []NodeMetrics{}}, nil
}

func (offlineClient) GetPodMetrics(context.Context, string, string) (PodMetricsResult, error) {
	return PodMetricsResult{Available: false, Pods: []PodMetrics{}}, nil
}

func (offlineClient) DeletePod(context.Context, string, string, string) error {
	return errOffline
}

func (offlineClient) RestartDeployment(context.Context, string, string, string) error {
	return errOffline
}

func (offlineClient) ScaleDeployment(context.Context, string, string, string, int32) error {
	return errOffline
}

// liveClient talks to a real cluster through a client-go clientset.
type liveClient struct {
	clientset   kubernetes.Interface
	metrics     metricsv1beta1.Interface
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
		ownerKind, ownerName := controllerOwner(p.OwnerReferences)
		pods = append(pods, Pod{
			Name:        p.Name,
			Namespace:   p.Namespace,
			Node:        p.Spec.NodeName,
			Phase:       string(p.Status.Phase),
			OwnerKind:   ownerKind,
			OwnerName:   ownerName,
			Labels:      p.Labels,
			Annotations: p.Annotations,
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
		ownerKind, ownerName := controllerOwner(rs.OwnerReferences)
		replicaSets = append(replicaSets, ReplicaSet{
			Name:      rs.Name,
			Namespace: rs.Namespace,
			Replicas: Replicas{
				Desired:   replicasValue(rs.Spec.Replicas),
				Ready:     rs.Status.ReadyReplicas,
				Available: rs.Status.AvailableReplicas,
				Updated:   0,
			},
			OwnerKind: ownerKind,
			OwnerName: ownerName,
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
			Selector:  svc.Spec.Selector,
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

// metricsUnavailable reports whether err means the metrics API is not installed
// or not reachable, in which case the endpoint should report available:false
// with HTTP 200 rather than an error.
func metricsUnavailable(err error) bool {
	return apierrors.IsNotFound(err) ||
		apierrors.IsServiceUnavailable(err) ||
		apierrors.IsMethodNotSupported(err) ||
		meta.IsNoMatchError(err)
}

type summaryFS struct {
	UsedBytes     int64 `json:"usedBytes"`
	CapacityBytes int64 `json:"capacityBytes"`
}

type summaryNetwork struct {
	RxBytes int64 `json:"rxBytes"`
	TxBytes int64 `json:"txBytes"`
}

type summaryNode struct {
	FS      summaryFS      `json:"fs"`
	Network summaryNetwork `json:"network"`
}

type summaryPodRef struct {
	Name      string `json:"name"`
	Namespace string `json:"namespace"`
}

type summaryPod struct {
	PodRef           summaryPodRef `json:"podRef"`
	EphemeralStorage struct {
		UsedBytes int64 `json:"usedBytes"`
	} `json:"ephemeral-storage"`
	Network summaryNetwork `json:"network"`
}

type summaryResponse struct {
	Node summaryNode  `json:"node"`
	Pods []summaryPod `json:"pods"`
}

// nodeSummary fetches the kubelet Summary API document for a node via the
// nodes/proxy subresource. Callers treat any error as "no data".
func (c *liveClient) nodeSummary(ctx context.Context, name string) (summaryResponse, error) {
	raw, err := c.clientset.CoreV1().RESTClient().Get().
		Resource("nodes").Name(name).
		SubResource("proxy").Suffix("stats/summary").
		DoRaw(ctx)
	if err != nil {
		return summaryResponse{}, err
	}
	var summary summaryResponse
	if err := json.Unmarshal(raw, &summary); err != nil {
		return summaryResponse{}, err
	}
	return summary, nil
}

// summaryPerCallBudget derives the deadline to grant ONE kubelet stats/summary
// call from the request context: min(summaryCallTimeout, remaining). The
// request context stays the parent, so across all summary waves the total
// summary time is bounded by the request deadline — once that budget runs out,
// pending calls fail fast and their nodes are skipped instead of pushing the
// whole endpoint into a request-level 504. The second return is false when the
// request budget is already exhausted and no fetch should be attempted.
func summaryPerCallBudget(ctx context.Context) (time.Duration, bool) {
	dl, ok := ctx.Deadline()
	if !ok {
		return summaryCallTimeout, true
	}
	remaining := time.Until(dl)
	if remaining <= 0 {
		return 0, false
	}
	return min(summaryCallTimeout, remaining), true
}

// podSummaries collects the kubelet Summary API pod entries for every node the
// given pods are scheduled on, keyed by "namespace/name". It is best effort:
// any node whose summary cannot be fetched (or does not answer within the
// summaryPerCallBudget deadline) is skipped. Nodes are fetched concurrently,
// bounded by summaryFetchConcurrency; each node's result lands in its own
// slice slot and the results are merged after the wait, so goroutines share no
// mutable state.
func (c *liveClient) podSummaries(ctx context.Context, nodeByPod map[string]string) map[string]summaryPod {
	nodeSet := map[string]struct{}{}
	for _, node := range nodeByPod {
		nodeSet[node] = struct{}{}
	}

	nodes := make([]string, 0, len(nodeSet))
	for node := range nodeSet {
		nodes = append(nodes, node)
	}

	per, ok := summaryPerCallBudget(ctx)
	if !ok {
		return map[string]summaryPod{} // request budget exhausted: skip all nodes
	}

	perNode := make([]map[string]summaryPod, len(nodes))
	sem := make(chan struct{}, summaryFetchConcurrency)
	var wg sync.WaitGroup
	for i, node := range nodes {
		wg.Add(1)
		go func(i int, node string) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()

			sctx, cancel := context.WithTimeout(ctx, per)
			defer cancel()
			summary, err := c.nodeSummary(sctx, node)
			if err != nil {
				return
			}
			pods := map[string]summaryPod{}
			for _, pod := range summary.Pods {
				pods[pod.PodRef.Namespace+"/"+pod.PodRef.Name] = pod
			}
			perNode[i] = pods
		}(i, node)
	}
	wg.Wait()

	out := map[string]summaryPod{}
	for _, pods := range perNode {
		for key, pod := range pods {
			out[key] = pod
		}
	}
	return out
}

// GetNodeMetrics reports live node resource usage from metrics-server, joined
// with allocatable capacity and pod counts from the core API and disk/network
// figures from the kubelet Summary API. When metrics-server is not installed it
// reports available:false with a non-nil empty slice rather than an error.
func (c *liveClient) GetNodeMetrics(ctx context.Context, _ string) (NodeMetricsResult, error) {
	if c.metrics == nil {
		return NodeMetricsResult{Available: false, Nodes: []NodeMetrics{}}, nil
	}

	list, err := c.metrics.MetricsV1beta1().NodeMetricses().List(ctx, metav1.ListOptions{})
	if err != nil {
		if metricsUnavailable(err) {
			return NodeMetricsResult{Available: false, Nodes: []NodeMetrics{}}, nil
		}
		return NodeMetricsResult{}, err
	}

	allocatable := map[string]corev1.ResourceList{}
	if nodes, err := c.clientset.CoreV1().Nodes().List(ctx, metav1.ListOptions{}); err == nil {
		for _, node := range nodes.Items {
			allocatable[node.Name] = node.Status.Allocatable
		}
	}

	podCounts := map[string]int32{}
	if pods, err := c.clientset.CoreV1().Pods(metav1.NamespaceAll).List(ctx, metav1.ListOptions{}); err == nil {
		for _, pod := range pods.Items {
			if pod.Spec.NodeName != "" {
				podCounts[pod.Spec.NodeName]++
			}
		}
	}

	out := make([]NodeMetrics, 0, len(list.Items))
	for _, item := range list.Items {
		nm := NodeMetrics{Name: item.Name}
		if qty, ok := item.Usage[corev1.ResourceCPU]; ok {
			nm.CPUMillis = qty.MilliValue()
		}
		if qty, ok := item.Usage[corev1.ResourceMemory]; ok {
			nm.MemoryBytes = qty.Value()
		}
		if res, ok := allocatable[item.Name]; ok {
			if qty, ok := res[corev1.ResourceCPU]; ok {
				nm.CPUAllocatableMillis = qty.MilliValue()
			}
			if qty, ok := res[corev1.ResourceMemory]; ok {
				nm.MemoryAllocatableBytes = qty.Value()
			}
		}
		nm.PodCount = podCounts[item.Name]
		out = append(out, nm)
	}

	// Fetch each node's kubelet summary concurrently, bounded by
	// summaryFetchConcurrency, with a per-call deadline capped at
	// summaryCallTimeout but never above the request budget remaining (the
	// request context is the parent), so an unresponsive kubelet costs a
	// skippable few seconds and large clusters fail fast instead of exhausting
	// the 15s request budget. Goroutines only touch their own out[i] slot;
	// results keep the nodes' ordering.
	per, ok := summaryPerCallBudget(ctx)
	if !ok {
		return NodeMetricsResult{Available: true, Nodes: out}, nil // request budget exhausted: skip summaries
	}
	sem := make(chan struct{}, summaryFetchConcurrency)
	var wg sync.WaitGroup
	for i := range out {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()

			sctx, cancel := context.WithTimeout(ctx, per)
			defer cancel()
			summary, err := c.nodeSummary(sctx, out[i].Name)
			if err != nil {
				return // best effort: this node keeps missing disk/network fields
			}
			out[i].DiskUsedBytes = summary.Node.FS.UsedBytes
			out[i].DiskCapacityBytes = summary.Node.FS.CapacityBytes
			out[i].NetworkRxBytes = summary.Node.Network.RxBytes
			out[i].NetworkTxBytes = summary.Node.Network.TxBytes
		}(i)
	}
	wg.Wait()

	return NodeMetricsResult{Available: true, Nodes: out}, nil
}

// GetPodMetrics reports live pod resource usage from metrics-server, joined with
// scheduling nodes from the core API and disk/network figures from the kubelet
// Summary API. When metrics-server is not installed it reports available:false
// with a non-nil empty slice rather than an error.
func (c *liveClient) GetPodMetrics(ctx context.Context, _ string, namespace string) (PodMetricsResult, error) {
	if c.metrics == nil {
		return PodMetricsResult{Available: false, Pods: []PodMetrics{}}, nil
	}

	ns := metav1.NamespaceAll
	if namespace != "" {
		ns = namespace
	}

	list, err := c.metrics.MetricsV1beta1().PodMetricses(ns).List(ctx, metav1.ListOptions{})
	if err != nil {
		if metricsUnavailable(err) {
			return PodMetricsResult{Available: false, Pods: []PodMetrics{}}, nil
		}
		return PodMetricsResult{}, err
	}

	nodeByPod := map[string]string{}
	if pods, err := c.clientset.CoreV1().Pods(ns).List(ctx, metav1.ListOptions{}); err == nil {
		for _, pod := range pods.Items {
			if pod.Spec.NodeName != "" {
				nodeByPod[pod.Namespace+"/"+pod.Name] = pod.Spec.NodeName
			}
		}
	}

	summaryPods := c.podSummaries(ctx, nodeByPod)

	out := make([]PodMetrics, 0, len(list.Items))
	for _, item := range list.Items {
		key := item.Namespace + "/" + item.Name
		pm := PodMetrics{
			Name:       item.Name,
			Namespace:  item.Namespace,
			Node:       nodeByPod[key],
			Containers: make([]ContainerMetrics, 0, len(item.Containers)),
		}
		for _, container := range item.Containers {
			entry := ContainerMetrics{Name: container.Name}
			if qty, ok := container.Usage[corev1.ResourceCPU]; ok {
				entry.CPUMillis = qty.MilliValue()
				pm.CPUMillis += entry.CPUMillis
			}
			if qty, ok := container.Usage[corev1.ResourceMemory]; ok {
				entry.MemoryBytes = qty.Value()
				pm.MemoryBytes += entry.MemoryBytes
			}
			pm.Containers = append(pm.Containers, entry)
		}
		if summary, ok := summaryPods[key]; ok {
			pm.DiskUsedBytes = summary.EphemeralStorage.UsedBytes
			pm.NetworkRxBytes = summary.Network.RxBytes
			pm.NetworkTxBytes = summary.Network.TxBytes
		}
		out = append(out, pm)
	}

	return PodMetricsResult{Available: true, Pods: out}, nil
}

// DeletePod removes a single pod from the cluster.
func (c *liveClient) DeletePod(ctx context.Context, _, namespace, pod string) error {
	return c.clientset.CoreV1().Pods(namespace).Delete(ctx, pod, metav1.DeleteOptions{})
}

// RestartDeployment triggers a rolling restart by bumping an annotation on the
// pod template — the same mechanism behind `kubectl rollout restart`.
func (c *liveClient) RestartDeployment(ctx context.Context, _, namespace, deployment string) error {
	patch := []byte(fmt.Sprintf(`{"spec":{"template":{"metadata":{"annotations":{"kubectl.kubernetes.io/restartedAt":%q}}}}}`, time.Now().UTC().Format(time.RFC3339)))
	_, err := c.clientset.AppsV1().Deployments(namespace).Patch(ctx, deployment, types.StrategicMergePatchType, patch, metav1.PatchOptions{})
	return err
}

// ScaleDeployment sets the deployment's desired replica count through the
// scale subresource, matching what `kubectl scale` does.
func (c *liveClient) ScaleDeployment(ctx context.Context, _, namespace, deployment string, replicas int32) error {
	_, err := c.clientset.AppsV1().Deployments(namespace).UpdateScale(ctx, deployment, &autoscalingv1.Scale{
		ObjectMeta: metav1.ObjectMeta{Name: deployment},
		Spec:       autoscalingv1.ScaleSpec{Replicas: replicas},
	}, metav1.UpdateOptions{})
	return err
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

// controllerOwner picks the managing controller from a resource's owner
// references, preferring the entry flagged as the controller. It returns empty
// strings when no controller owner exists (e.g. a standalone pod).
func controllerOwner(refs []metav1.OwnerReference) (kind, name string) {
	for i := range refs {
		if refs[i].Controller != nil && *refs[i].Controller {
			return refs[i].Kind, refs[i].Name
		}
	}
	return "", ""
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

type nodeMetricsResponse struct {
	Source    string        `json:"source"`
	Available bool          `json:"available"`
	Nodes     []NodeMetrics `json:"nodes"`
}

type podMetricsResponse struct {
	Source    string       `json:"source"`
	Available bool         `json:"available"`
	Pods      []PodMetrics `json:"pods"`
}

type errorResponse struct {
	Error string `json:"error"`
}

// actionResponse confirms a successful mutating operation.
type actionResponse struct {
	Source  string `json:"source"`
	OK      bool   `json:"ok"`
	Message string `json:"message,omitempty"`
}

// api holds the dependencies shared by all handlers. clientset and
// restConfig are the raw client-go seam for the exec/websocket routes
// (xdisplay.go, exec.go); both are nil in offline mode, where those routes
// answer 503 like the other write endpoints. xdisplay is the display
// pool allocator (static, in-memory).
type api struct {
	client     ClusterClient
	source     string
	clientset  kubernetes.Interface
	restConfig *rest.Config
	xdisplay   *xDisplayAllocator
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

func (a *api) handleMetricsNodes(w http.ResponseWriter, r *http.Request) {
	result, err := a.client.GetNodeMetrics(r.Context(), r.URL.Query().Get("cluster"))
	if err != nil {
		writeError(w, err)
		return
	}
	nodes := result.Nodes
	if nodes == nil {
		nodes = []NodeMetrics{}
	}
	writeJSON(w, http.StatusOK, nodeMetricsResponse{Source: a.source, Available: result.Available, Nodes: nodes})
}

func (a *api) handleMetricsPods(w http.ResponseWriter, r *http.Request) {
	query := r.URL.Query()
	result, err := a.client.GetPodMetrics(r.Context(), query.Get("cluster"), query.Get("namespace"))
	if err != nil {
		writeError(w, err)
		return
	}
	pods := result.Pods
	if pods == nil {
		pods = []PodMetrics{}
	}
	writeJSON(w, http.StatusOK, podMetricsResponse{Source: a.source, Available: result.Available, Pods: pods})
}

func (a *api) handleDeletePod(w http.ResponseWriter, r *http.Request) {
	query := r.URL.Query()

	namespace := query.Get("namespace")
	if namespace == "" {
		writeJSON(w, http.StatusBadRequest, errorResponse{Error: "missing required query parameter: namespace"})
		return
	}
	pod := query.Get("pod")
	if pod == "" {
		writeJSON(w, http.StatusBadRequest, errorResponse{Error: "missing required query parameter: pod"})
		return
	}

	if err := a.client.DeletePod(r.Context(), query.Get("cluster"), namespace, pod); err != nil {
		writeError(w, err)
		return
	}

	writeJSON(w, http.StatusOK, actionResponse{
		Source:  a.source,
		OK:      true,
		Message: fmt.Sprintf("Deleted pod %s/%s", namespace, pod),
	})
}

func (a *api) handleRestartDeployment(w http.ResponseWriter, r *http.Request) {
	query := r.URL.Query()

	namespace := query.Get("namespace")
	if namespace == "" {
		writeJSON(w, http.StatusBadRequest, errorResponse{Error: "missing required query parameter: namespace"})
		return
	}
	deployment := query.Get("deployment")
	if deployment == "" {
		writeJSON(w, http.StatusBadRequest, errorResponse{Error: "missing required query parameter: deployment"})
		return
	}

	if err := a.client.RestartDeployment(r.Context(), query.Get("cluster"), namespace, deployment); err != nil {
		writeError(w, err)
		return
	}

	writeJSON(w, http.StatusOK, actionResponse{
		Source:  a.source,
		OK:      true,
		Message: fmt.Sprintf("Restarted deployment %s/%s", namespace, deployment),
	})
}

func (a *api) handleScaleDeployment(w http.ResponseWriter, r *http.Request) {
	query := r.URL.Query()

	namespace := query.Get("namespace")
	if namespace == "" {
		writeJSON(w, http.StatusBadRequest, errorResponse{Error: "missing required query parameter: namespace"})
		return
	}
	deployment := query.Get("deployment")
	if deployment == "" {
		writeJSON(w, http.StatusBadRequest, errorResponse{Error: "missing required query parameter: deployment"})
		return
	}
	raw := query.Get("replicas")
	if raw == "" {
		writeJSON(w, http.StatusBadRequest, errorResponse{Error: "missing required query parameter: replicas"})
		return
	}
	replicas, err := strconv.ParseInt(raw, 10, 32)
	if err != nil || replicas < 0 || replicas > maxScaleReplicas {
		writeJSON(w, http.StatusBadRequest, errorResponse{Error: "invalid replicas"})
		return
	}

	if err := a.client.ScaleDeployment(r.Context(), query.Get("cluster"), namespace, deployment, int32(replicas)); err != nil {
		writeError(w, err)
		return
	}

	writeJSON(w, http.StatusOK, actionResponse{
		Source:  a.source,
		OK:      true,
		Message: fmt.Sprintf("Scaled deployment %s/%s to %d replicas", namespace, deployment, replicas),
	})
}

// newMux wires the method-aware routes (Go 1.22+ patterns).
func newMux(a *api) *http.ServeMux {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/health", a.handleHealth)
	mux.HandleFunc("GET /api/clusters", a.handleClusters)
	mux.HandleFunc("GET /api/nodes", a.handleNodes)
	mux.HandleFunc("GET /api/nodes/detail", a.handleNodeDetail)
	mux.HandleFunc("GET /api/pods", a.handlePods)
	mux.HandleFunc("DELETE /api/pods", a.handleDeletePod)
	mux.HandleFunc("POST /api/deployments/restart", a.handleRestartDeployment)
	mux.HandleFunc("POST /api/deployments/scale", a.handleScaleDeployment)
	mux.HandleFunc("GET /api/pods/logs", a.handlePodLogs)
	mux.HandleFunc("GET /api/metrics/nodes", a.handleMetricsNodes)
	mux.HandleFunc("GET /api/metrics/pods", a.handleMetricsPods)
	mux.HandleFunc("GET /api/namespaces", a.handleNamespaces)
	mux.HandleFunc("GET /api/deployments", a.handleDeployments)
	mux.HandleFunc("GET /api/replicasets", a.handleReplicaSets)
	mux.HandleFunc("GET /api/replicationcontrollers", a.handleReplicationControllers)
	mux.HandleFunc("GET /api/services", a.handleServices)
	mux.HandleFunc("POST /api/xdisplay", a.handleXDisplayCreate)
	mux.HandleFunc("DELETE /api/xdisplay", a.handleXDisplayDelete)
	mux.HandleFunc("GET /api/xdisplay/list", a.handleXDisplayList)
	mux.HandleFunc("GET /api/xdisplay/health", a.handleXDisplayHealth)
	mux.HandleFunc("GET /api/xdisplay/ws", a.handleXDisplayWS)
	mux.HandleFunc("GET /api/exec/ws", a.handleExecWS)
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
	switch {
	case errors.Is(err, context.DeadlineExceeded):
		status = http.StatusGatewayTimeout // 504 — request / summary budget exhausted
	case errors.Is(err, errOffline):
		status = http.StatusServiceUnavailable // 503
	case apierrors.IsNotFound(err):
		status = http.StatusNotFound // 404
	case apierrors.IsForbidden(err):
		status = http.StatusForbidden // 403 — RBAC
	case apierrors.IsUnauthorized(err):
		status = http.StatusUnauthorized // 401
	case apierrors.IsConflict(err):
		status = http.StatusConflict // 409
	case apierrors.IsInvalid(err), apierrors.IsBadRequest(err):
		status = http.StatusBadRequest // 400
	}
	writeJSON(w, status, errorResponse{Error: err.Error()})
}

// defaultAllowedOrigins are the origins allowed by default (Vite dev + preview).
var defaultAllowedOrigins = []string{
	"http://localhost:5173",
	"http://127.0.0.1:5173",
	"http://localhost:4173",
	"http://127.0.0.1:4173",
}

// parseAllowedOrigins returns the configured CORS allowlist. An unset or empty
// KOS_ALLOWED_ORIGINS falls back to defaultAllowedOrigins; a set-but-all-empty
// value (e.g. ",") yields an empty list, so an operator can intentionally
// disable every browser origin. Entries are trimmed and empties dropped.
func parseAllowedOrigins() []string {
	raw := os.Getenv("KOS_ALLOWED_ORIGINS")
	if raw == "" {
		return defaultAllowedOrigins
	}
	parts := strings.Split(raw, ",")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		if t := strings.TrimSpace(p); t != "" {
			out = append(out, t)
		}
	}
	return out
}

func isOriginAllowed(origin string) bool {
	for _, o := range parseAllowedOrigins() {
		if o == origin {
			return true
		}
	}
	return false
}

// withRequestTimeout bounds every request with a context deadline so a slow
// cluster client cannot pin handler goroutines indefinitely. A request that
// already carries a deadline is passed through unchanged. The production chain
// uses requestTimeout; tests inject a shorter value.
func withRequestTimeout(d time.Duration) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if _, hasDeadline := r.Context().Deadline(); !hasDeadline {
				ctx, cancel := context.WithTimeout(r.Context(), d)
				defer cancel()
				r = r.WithContext(ctx)
			}
			next.ServeHTTP(w, r)
		})
	}
}

// withCORS restricts origins and enforces write-endpoint hardening.
func withCORS(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Vary", "Origin")

		origin := r.Header.Get("Origin")
		// A disallowed (or absent) origin gets no Access-Control-Allow-Origin.
		allowed := origin != "" && isOriginAllowed(origin)
		if allowed {
			w.Header().Set("Access-Control-Allow-Origin", origin)
		}

		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization")

		if origin != "" && !allowed {
			switch r.Method {
			case http.MethodOptions, http.MethodPost, http.MethodDelete:
				writeJSON(w, http.StatusForbidden, errorResponse{Error: "origin not allowed"})
				return
			}
		}

		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}

		next.ServeHTTP(w, r)
	})
}

// isK8sName reports whether name is a valid RFC 1123 DNS label — the naming
// constraint shared by namespaces, pods and containers, i.e. every field this
// server interpolates into exec/REST paths. Returns false for empty input.
func isK8sName(name string) bool {
	if len(name) == 0 || len(name) > maxK8sNameLength {
		return false
	}
	if name[0] == '-' || name[len(name)-1] == '-' {
		return false
	}
	for i := 0; i < len(name); i++ {
		c := name[i]
		alnum := (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9')
		if !alnum && c != '-' {
			return false
		}
	}
	return true
}

// redactRequestURI returns uri with the value of every query parameter
// named "token" replaced by [redacted]. Request URIs sometimes carry
// bearer-like query params (the xdisplay websocket path) and must never
// reach the access log verbatim; anything that fails to parse is returned
// unchanged (the logging middleware then logs the raw URI — still safer
// than guessing at malformed input).
func redactRequestURI(uri string) string {
	idx := strings.IndexByte(uri, '?')
	if idx < 0 {
		return uri
	}
	values, err := urlpkg.ParseQuery(uri[idx+1:])
	if err != nil {
		return uri
	}
	redacted := false
	for key := range values {
		if strings.EqualFold(key, "token") {
			values[key] = []string{"[redacted]"}
			redacted = true
		}
	}
	if !redacted {
		return uri
	}
	return uri[:idx] + "?" + values.Encode()
}

// withLogging emits one minimal line per request to stderr, with bearer-like
// query parameters scrubbed (see redactRequestURI).
func withLogging(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		next.ServeHTTP(w, r)
		log.Printf("%s %s %s", r.Method, redactRequestURI(r.URL.RequestURI()), time.Since(start).Round(time.Millisecond))
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

// buildClient returns a live cluster client (plus the raw client-go seams
// the exec/websocket routes need) when configuration is available, an
// offline client otherwise. It never fails.
func buildClient() (ClusterClient, kubernetes.Interface, *rest.Config, string) {
	setup, err := loadKubeSetup()
	if err != nil {
		log.Printf("kubernetes unavailable, serving offline: %v", err)
		return offlineClient{}, nil, nil, offlineSource
	}

	clientset, err := kubernetes.NewForConfig(setup.cfg)
	if err != nil {
		log.Printf("kubernetes client init failed, serving offline: %v", err)
		return offlineClient{}, nil, nil, offlineSource
	}

	// A nil metrics client means "metrics-server not installed"; the metrics
	// endpoints then report available:false while everything else stays live.
	var metricsClient metricsv1beta1.Interface
	if mc, metricsErr := metricsv1beta1.NewForConfig(setup.cfg); metricsErr == nil {
		metricsClient = mc
	}

	return &liveClient{
		clientset:   clientset,
		metrics:     metricsClient,
		clusterID:   setup.name,
		clusterName: setup.name,
		server:      setup.cfg.Host,
	}, clientset, setup.cfg, liveSource
}

func main() {
	log.SetOutput(os.Stderr)
	log.SetFlags(log.LstdFlags)

	port := os.Getenv("PORT")
	if port == "" {
		port = defaultPort
	}

	client, clientset, restConfig, source := buildClient()
	xdisplay := newXDisplayAllocator()
	handler := withLogging(withCORS(withRequestTimeout(requestTimeout)(newMux(&api{
		client:     client,
		source:     source,
		clientset:  clientset,
		restConfig: restConfig,
		xdisplay:   xdisplay,
	}))))

	srv := &http.Server{
		Addr:              ":" + port,
		Handler:           handler,
		ReadHeaderTimeout: 10 * time.Second,
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	// Session reaper rides the shutdown-cancelling context, so a signal
	// tears both the listener and the sweeper goroutine down.
	go newXDisplaySweeper(restConfig, xdisplay, newXServerCoord()).run(ctx)

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
