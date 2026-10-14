package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"

	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/client-go/kubernetes/fake"
	k8stesting "k8s.io/client-go/testing"
)

// stubClient records every argument it receives and returns canned data, so
// handler tests can assert that query parameters reach the ClusterClient seam.
type stubClient struct {
	clusters    []ClusterRef
	nodes       []Node
	pods        []Pod
	namespaces  []Namespace
	deployments []Deployment
	replicaSets []ReplicaSet
	controllers []ReplicationController
	services    []Service
	node        NodeDetail
	logs        string
	nodeMetrics NodeMetricsResult
	podMetrics  PodMetricsResult
	err         error

	gotCluster   string
	gotNode      string
	gotNamespace string
	gotSelector  string
	gotPod       string
	gotContainer string
	gotTailLines int
}

func (s *stubClient) ListClusters(context.Context) ([]ClusterRef, error) {
	if s.err != nil {
		return nil, s.err
	}
	return s.clusters, nil
}

func (s *stubClient) ListNodes(_ context.Context, clusterID string) ([]Node, error) {
	s.gotCluster = clusterID
	if s.err != nil {
		return nil, s.err
	}
	return s.nodes, nil
}

func (s *stubClient) ListPods(_ context.Context, clusterID, node, namespace, selector string) ([]Pod, error) {
	s.gotCluster, s.gotNode, s.gotNamespace, s.gotSelector = clusterID, node, namespace, selector
	if s.err != nil {
		return nil, s.err
	}
	return s.pods, nil
}

func (s *stubClient) ListNamespaces(_ context.Context, clusterID string) ([]Namespace, error) {
	s.gotCluster = clusterID
	if s.err != nil {
		return nil, s.err
	}
	return s.namespaces, nil
}

func (s *stubClient) ListDeployments(_ context.Context, clusterID, namespace string) ([]Deployment, error) {
	s.gotCluster, s.gotNamespace = clusterID, namespace
	if s.err != nil {
		return nil, s.err
	}
	return s.deployments, nil
}

func (s *stubClient) ListReplicaSets(_ context.Context, clusterID, namespace string) ([]ReplicaSet, error) {
	s.gotCluster, s.gotNamespace = clusterID, namespace
	if s.err != nil {
		return nil, s.err
	}
	return s.replicaSets, nil
}

func (s *stubClient) ListReplicationControllers(_ context.Context, clusterID, namespace string) ([]ReplicationController, error) {
	s.gotCluster, s.gotNamespace = clusterID, namespace
	if s.err != nil {
		return nil, s.err
	}
	return s.controllers, nil
}

func (s *stubClient) ListServices(_ context.Context, clusterID, namespace string) ([]Service, error) {
	s.gotCluster, s.gotNamespace = clusterID, namespace
	if s.err != nil {
		return nil, s.err
	}
	return s.services, nil
}

func (s *stubClient) GetNode(_ context.Context, clusterID, name string) (NodeDetail, error) {
	s.gotCluster, s.gotNode = clusterID, name
	if s.err != nil {
		return NodeDetail{}, s.err
	}
	return s.node, nil
}

func (s *stubClient) PodLogs(_ context.Context, clusterID, namespace, pod, container string, tailLines int) (string, error) {
	s.gotCluster, s.gotNamespace, s.gotPod, s.gotContainer, s.gotTailLines = clusterID, namespace, pod, container, tailLines
	if s.err != nil {
		return "", s.err
	}
	return s.logs, nil
}

func (s *stubClient) GetNodeMetrics(_ context.Context, clusterID string) (NodeMetricsResult, error) {
	s.gotCluster = clusterID
	if s.err != nil {
		return NodeMetricsResult{}, s.err
	}
	return s.nodeMetrics, nil
}

func (s *stubClient) GetPodMetrics(_ context.Context, clusterID, namespace string) (PodMetricsResult, error) {
	s.gotCluster, s.gotNamespace = clusterID, namespace
	if s.err != nil {
		return PodMetricsResult{}, s.err
	}
	return s.podMetrics, nil
}

func serve(t *testing.T, client ClusterClient, method, target string) *httptest.ResponseRecorder {
	t.Helper()
	mux := newMux(&api{client: client, source: liveSource})
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest(method, target, nil))
	return rec
}

func assertStatus(t *testing.T, rec *httptest.ResponseRecorder, want int) {
	t.Helper()
	if rec.Code != want {
		t.Fatalf("status = %d, want %d; body=%s", rec.Code, want, rec.Body.String())
	}
}

func assertJSONContentType(t *testing.T, rec *httptest.ResponseRecorder) {
	t.Helper()
	if ct := rec.Header().Get("Content-Type"); !strings.HasPrefix(ct, "application/json") {
		t.Fatalf("Content-Type = %q, want application/json", ct)
	}
}

func decodeBody[T any](t *testing.T, rec *httptest.ResponseRecorder) T {
	t.Helper()
	var out T
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("decode response: %v; body=%s", err, rec.Body.String())
	}
	return out
}

func TestHandleNamespaces(t *testing.T) {
	stub := &stubClient{namespaces: []Namespace{{Name: "default", Status: "Active"}}}
	rec := serve(t, stub, http.MethodGet, "/api/namespaces?cluster=c1")

	assertStatus(t, rec, http.StatusOK)
	assertJSONContentType(t, rec)

	got := decodeBody[namespacesResponse](t, rec)
	if got.Source != liveSource {
		t.Errorf("source = %q, want %q", got.Source, liveSource)
	}
	if len(got.Namespaces) != 1 || got.Namespaces[0].Name != "default" || got.Namespaces[0].Status != "Active" {
		t.Errorf("namespaces = %+v", got.Namespaces)
	}
	if stub.gotCluster != "c1" {
		t.Errorf("cluster forwarded = %q, want c1", stub.gotCluster)
	}
}

func TestHandleDeployments(t *testing.T) {
	stub := &stubClient{deployments: []Deployment{{
		Name:      "web",
		Namespace: "default",
		Replicas:  Replicas{Desired: 3, Ready: 3, Available: 3, Updated: 3},
		Images:    []string{"nginx:1.27"},
	}}}
	rec := serve(t, stub, http.MethodGet, "/api/deployments?cluster=c1&namespace=default")

	assertStatus(t, rec, http.StatusOK)
	assertJSONContentType(t, rec)

	got := decodeBody[deploymentsResponse](t, rec)
	if got.Source != liveSource {
		t.Errorf("source = %q, want %q", got.Source, liveSource)
	}
	if len(got.Deployments) != 1 {
		t.Fatalf("deployments = %+v", got.Deployments)
	}
	d := got.Deployments[0]
	if d.Name != "web" || d.Namespace != "default" || d.Replicas.Desired != 3 || len(d.Images) != 1 || d.Images[0] != "nginx:1.27" {
		t.Errorf("deployment = %+v", d)
	}
	if stub.gotNamespace != "default" {
		t.Errorf("namespace forwarded = %q, want default", stub.gotNamespace)
	}
}

func TestHandleReplicaSets(t *testing.T) {
	stub := &stubClient{replicaSets: []ReplicaSet{{
		Name:      "web-abc",
		Namespace: "default",
		Replicas:  Replicas{Desired: 3, Ready: 3, Available: 3},
	}}}
	rec := serve(t, stub, http.MethodGet, "/api/replicasets?cluster=c1&namespace=default")

	assertStatus(t, rec, http.StatusOK)
	assertJSONContentType(t, rec)

	got := decodeBody[replicaSetsResponse](t, rec)
	if len(got.ReplicaSets) != 1 || got.ReplicaSets[0].Name != "web-abc" {
		t.Errorf("replicasets = %+v", got.ReplicaSets)
	}
	if stub.gotNamespace != "default" {
		t.Errorf("namespace forwarded = %q, want default", stub.gotNamespace)
	}
}

func TestHandleReplicationControllers(t *testing.T) {
	stub := &stubClient{controllers: []ReplicationController{{
		Name:      "legacy",
		Namespace: "default",
		Replicas:  Replicas{Desired: 2, Ready: 2, Available: 2},
	}}}
	rec := serve(t, stub, http.MethodGet, "/api/replicationcontrollers?cluster=c1&namespace=default")

	assertStatus(t, rec, http.StatusOK)
	assertJSONContentType(t, rec)

	got := decodeBody[replicationControllersResponse](t, rec)
	if len(got.ReplicationControllers) != 1 || got.ReplicationControllers[0].Name != "legacy" {
		t.Errorf("replicationcontrollers = %+v", got.ReplicationControllers)
	}
	if stub.gotNamespace != "default" {
		t.Errorf("namespace forwarded = %q, want default", stub.gotNamespace)
	}
}

func TestHandleServices(t *testing.T) {
	stub := &stubClient{services: []Service{{
		Name:      "web",
		Namespace: "default",
		Type:      "ClusterIP",
		ClusterIP: "10.0.0.10",
		Ports:     []ServicePort{{Name: "http", Port: 80, Protocol: "TCP", TargetPort: "8080"}},
	}}}
	rec := serve(t, stub, http.MethodGet, "/api/services?cluster=c1&namespace=default")

	assertStatus(t, rec, http.StatusOK)
	assertJSONContentType(t, rec)

	got := decodeBody[servicesResponse](t, rec)
	if len(got.Services) != 1 {
		t.Fatalf("services = %+v", got.Services)
	}
	svc := got.Services[0]
	if svc.Type != "ClusterIP" || svc.ClusterIP != "10.0.0.10" || len(svc.Ports) != 1 || svc.Ports[0].TargetPort != "8080" {
		t.Errorf("service = %+v", svc)
	}
	if stub.gotNamespace != "default" {
		t.Errorf("namespace forwarded = %q, want default", stub.gotNamespace)
	}
}

func TestHandleNodeDetail(t *testing.T) {
	stub := &stubClient{node: NodeDetail{
		Name:        "n1",
		Status:      "Ready",
		Roles:       []string{"control-plane"},
		Version:     "v1.30.0",
		Capacity:    map[string]string{"cpu": "4", "memory": "16Gi"},
		Allocatable: map[string]string{"cpu": "4", "memory": "16Gi"},
		Conditions:  []NodeCondition{{Type: "Ready", Status: "True"}},
		Addresses:   []NodeAddress{{Type: "InternalIP", Address: "10.0.0.1"}},
	}}
	rec := serve(t, stub, http.MethodGet, "/api/nodes/detail?cluster=c1&name=n1")

	assertStatus(t, rec, http.StatusOK)
	assertJSONContentType(t, rec)

	got := decodeBody[nodeDetailResponse](t, rec)
	if got.Source != liveSource {
		t.Errorf("source = %q, want %q", got.Source, liveSource)
	}
	n := got.Node
	if n.Name != "n1" || n.Status != "Ready" || n.Version != "v1.30.0" || len(n.Roles) != 1 || n.Roles[0] != "control-plane" {
		t.Errorf("node = %+v", n)
	}
	if n.Capacity["memory"] != "16Gi" || n.Allocatable["cpu"] != "4" {
		t.Errorf("node resources = %+v / %+v", n.Capacity, n.Allocatable)
	}
	if len(n.Conditions) != 1 || n.Conditions[0].Type != "Ready" || n.Conditions[0].Status != "True" {
		t.Errorf("node conditions = %+v", n.Conditions)
	}
	if len(n.Addresses) != 1 || n.Addresses[0].Type != "InternalIP" || n.Addresses[0].Address != "10.0.0.1" {
		t.Errorf("node addresses = %+v", n.Addresses)
	}
	if stub.gotNode != "n1" {
		t.Errorf("name forwarded = %q, want n1", stub.gotNode)
	}
}

func TestHandleNodeDetailMissingName(t *testing.T) {
	rec := serve(t, &stubClient{}, http.MethodGet, "/api/nodes/detail?cluster=c1")

	assertStatus(t, rec, http.StatusBadRequest)
	got := decodeBody[errorResponse](t, rec)
	if got.Error == "" {
		t.Fatal("expected an error message for a missing name")
	}
}

func TestHandlePodsForwardsFilters(t *testing.T) {
	stub := &stubClient{pods: []Pod{{Name: "p1", Namespace: "default", Node: "n1", Phase: "Running"}}}
	rec := serve(t, stub, http.MethodGet, "/api/pods?cluster=c1&node=n1&namespace=default&selector=app%3Dweb")

	assertStatus(t, rec, http.StatusOK)
	assertJSONContentType(t, rec)

	got := decodeBody[podsResponse](t, rec)
	if len(got.Pods) != 1 || got.Pods[0].Name != "p1" {
		t.Errorf("pods = %+v", got.Pods)
	}
	if stub.gotCluster != "c1" || stub.gotNode != "n1" || stub.gotNamespace != "default" || stub.gotSelector != "app=web" {
		t.Errorf("forwarded args = cluster=%q node=%q namespace=%q selector=%q", stub.gotCluster, stub.gotNode, stub.gotNamespace, stub.gotSelector)
	}
}

func TestHandlePodLogsTailLines(t *testing.T) {
	cases := []struct {
		name  string
		query string
		want  int
	}{
		{"default", "/api/pods/logs?cluster=c1&namespace=default&pod=p1", 200},
		{"explicit", "/api/pods/logs?cluster=c1&namespace=default&pod=p1&tailLines=50", 50},
		{"lower clamp", "/api/pods/logs?cluster=c1&namespace=default&pod=p1&tailLines=0", 1},
		{"upper clamp", "/api/pods/logs?cluster=c1&namespace=default&pod=p1&tailLines=999999", 5000},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			stub := &stubClient{logs: "line one\nline two\n"}
			rec := serve(t, stub, http.MethodGet, tc.query)

			assertStatus(t, rec, http.StatusOK)
			assertJSONContentType(t, rec)

			got := decodeBody[podLogsResponse](t, rec)
			if got.Source != liveSource || got.Logs != "line one\nline two\n" {
				t.Errorf("body = %+v", got)
			}
			if stub.gotTailLines != tc.want {
				t.Errorf("tailLines forwarded = %d, want %d", stub.gotTailLines, tc.want)
			}
			if stub.gotNamespace != "default" || stub.gotPod != "p1" {
				t.Errorf("namespace/pod forwarded = %q/%q", stub.gotNamespace, stub.gotPod)
			}
		})
	}
}

func TestHandlePodLogsInvalidTailLines(t *testing.T) {
	rec := serve(t, &stubClient{}, http.MethodGet, "/api/pods/logs?cluster=c1&namespace=default&pod=p1&tailLines=abc")
	assertStatus(t, rec, http.StatusBadRequest)
}

func TestMethodNotAllowed(t *testing.T) {
	rec := serve(t, &stubClient{}, http.MethodPost, "/api/nodes")
	if rec.Code == http.StatusOK {
		t.Fatal("POST /api/nodes unexpectedly succeeded")
	}
	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusMethodNotAllowed)
	}
}

func TestOfflineResponsesUseEmptyArrays(t *testing.T) {
	mux := newMux(&api{client: offlineClient{}, source: offlineSource})

	cases := []struct {
		path string
		key  string
	}{
		{"/api/clusters", "clusters"},
		{"/api/nodes", "nodes"},
		{"/api/pods", "pods"},
		{"/api/namespaces", "namespaces"},
		{"/api/deployments?namespace=default", "deployments"},
		{"/api/replicasets?namespace=default", "replicasets"},
		{"/api/replicationcontrollers?namespace=default", "replicationcontrollers"},
		{"/api/services?namespace=default", "services"},
	}

	for _, tc := range cases {
		t.Run(tc.path, func(t *testing.T) {
			rec := httptest.NewRecorder()
			mux.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, tc.path, nil))
			assertStatus(t, rec, http.StatusOK)

			var raw map[string]json.RawMessage
			if err := json.Unmarshal(rec.Body.Bytes(), &raw); err != nil {
				t.Fatalf("decode response: %v", err)
			}
			if src := string(raw["source"]); src != `"offline"` {
				t.Errorf("source = %s, want \"offline\"", src)
			}
			if got := string(raw[tc.key]); got != "[]" {
				t.Errorf("%s = %s, want []", tc.key, got)
			}
		})
	}

	t.Run("node detail", func(t *testing.T) {
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/nodes/detail?name=n1", nil))
		assertStatus(t, rec, http.StatusOK)

		var raw struct {
			Node map[string]json.RawMessage `json:"node"`
		}
		if err := json.Unmarshal(rec.Body.Bytes(), &raw); err != nil {
			t.Fatalf("decode response: %v", err)
		}
		for _, key := range []string{"roles", "conditions", "addresses"} {
			if got := string(raw.Node[key]); got != "[]" {
				t.Errorf("node.%s = %s, want []", key, got)
			}
		}
		for _, key := range []string{"capacity", "allocatable"} {
			if got := string(raw.Node[key]); got != "{}" {
				t.Errorf("node.%s = %s, want {}", key, got)
			}
		}
	})

	t.Run("pod logs", func(t *testing.T) {
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/pods/logs?namespace=default&pod=p1", nil))
		assertStatus(t, rec, http.StatusOK)

		got := decodeBody[podLogsResponse](t, rec)
		if got.Logs != "" {
			t.Errorf("logs = %q, want empty", got.Logs)
		}
	})
}

func TestErrorMapping(t *testing.T) {
	t.Run("not found -> 404", func(t *testing.T) {
		stub := &stubClient{err: apierrors.NewNotFound(schema.GroupResource{Resource: "nodes"}, "n1")}
		rec := serve(t, stub, http.MethodGet, "/api/nodes/detail?name=n1")

		assertStatus(t, rec, http.StatusNotFound)
		got := decodeBody[errorResponse](t, rec)
		if got.Error == "" {
			t.Fatal("expected a non-empty error message")
		}
	})

	t.Run("generic error -> 500", func(t *testing.T) {
		stub := &stubClient{err: errors.New("boom")}
		rec := serve(t, stub, http.MethodGet, "/api/nodes")

		assertStatus(t, rec, http.StatusInternalServerError)
		got := decodeBody[errorResponse](t, rec)
		if got.Error != "boom" {
			t.Errorf("error = %q, want boom", got.Error)
		}
	})
}

func TestNodeStatus(t *testing.T) {
	cases := []struct {
		name string
		node *corev1.Node
		want string
	}{
		{
			name: "ready",
			node: &corev1.Node{Status: corev1.NodeStatus{Conditions: []corev1.NodeCondition{{Type: corev1.NodeReady, Status: corev1.ConditionTrue}}}},
			want: "Ready",
		},
		{
			name: "not ready",
			node: &corev1.Node{Status: corev1.NodeStatus{Conditions: []corev1.NodeCondition{{Type: corev1.NodeReady, Status: corev1.ConditionFalse}}}},
			want: "NotReady",
		},
		{
			name: "unknown status",
			node: &corev1.Node{Status: corev1.NodeStatus{Conditions: []corev1.NodeCondition{{Type: corev1.NodeReady, Status: corev1.ConditionUnknown}}}},
			want: "NotReady",
		},
		{
			name: "no conditions",
			node: &corev1.Node{},
			want: "Unknown",
		},
		{
			name: "only unrelated condition",
			node: &corev1.Node{Status: corev1.NodeStatus{Conditions: []corev1.NodeCondition{{Type: corev1.NodeMemoryPressure, Status: corev1.ConditionTrue}}}},
			want: "Unknown",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := nodeStatus(tc.node); got != tc.want {
				t.Errorf("nodeStatus = %q, want %q", got, tc.want)
			}
		})
	}
}

func TestNodeRoles(t *testing.T) {
	t.Run("sorted and prefix stripped", func(t *testing.T) {
		node := &corev1.Node{ObjectMeta: metav1.ObjectMeta{Labels: map[string]string{
			"node-role.kubernetes.io/worker":        "",
			"node-role.kubernetes.io/control-plane": "",
			"kubernetes.io/hostname":                "n1",
			"node-role.kubernetes.io/":              "",
		}}}
		want := []string{"control-plane", "worker"}
		if got := nodeRoles(node); !reflect.DeepEqual(got, want) {
			t.Errorf("nodeRoles = %v, want %v", got, want)
		}
	})

	t.Run("no role labels yields empty non-nil slice", func(t *testing.T) {
		node := &corev1.Node{ObjectMeta: metav1.ObjectMeta{Labels: map[string]string{"kubernetes.io/hostname": "n1"}}}
		got := nodeRoles(node)
		if got == nil {
			t.Fatal("nodeRoles returned nil, want non-nil empty slice")
		}
		if len(got) != 0 {
			t.Errorf("nodeRoles = %v, want empty", got)
		}
	})
}

func TestLiveClientListPodsAndGetNode(t *testing.T) {
	readyTrue := corev1.ConditionTrue

	node := &corev1.Node{
		ObjectMeta: metav1.ObjectMeta{
			Name:   "n1",
			Labels: map[string]string{"node-role.kubernetes.io/control-plane": ""},
		},
		Status: corev1.NodeStatus{
			Conditions: []corev1.NodeCondition{{Type: corev1.NodeReady, Status: readyTrue}},
			NodeInfo:   corev1.NodeSystemInfo{KubeletVersion: "v1.30.0"},
			Capacity: corev1.ResourceList{
				corev1.ResourceCPU:    resource.MustParse("4"),
				corev1.ResourceMemory: resource.MustParse("16Gi"),
			},
			Allocatable: corev1.ResourceList{
				corev1.ResourceCPU:    resource.MustParse("4"),
				corev1.ResourceMemory: resource.MustParse("16Gi"),
			},
			Addresses: []corev1.NodeAddress{{Type: corev1.NodeInternalIP, Address: "10.0.0.1"}},
		},
	}

	pod := func(name, namespace, nodeName string, labels map[string]string) *corev1.Pod {
		return &corev1.Pod{
			ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: namespace, Labels: labels},
			Spec:       corev1.PodSpec{NodeName: nodeName},
			Status:     corev1.PodStatus{Phase: corev1.PodRunning},
		}
	}

	p1 := pod("p1", "default", "n1", map[string]string{"app": "web", "tier": "frontend"})
	p2 := pod("p2", "default", "n2", map[string]string{"app": "web"})
	p3 := pod("p3", "kube-system", "n1", map[string]string{"app": "web", "tier": "frontend"})

	clientset := fake.NewSimpleClientset(node, p1, p2, p3)
	client := &liveClient{clientset: clientset}

	// The fake clientset filters namespace and label selector, but ignores the
	// node field selector (gentype's fake List drops it). Capture the field
	// selector off the ListAction so the forwarding is still asserted.
	var gotFieldSelector string
	clientset.PrependReactor("list", "pods", func(action k8stesting.Action) (bool, runtime.Object, error) {
		if list, ok := action.(k8stesting.ListAction); ok {
			gotFieldSelector = list.GetListRestrictions().Fields.String()
		}
		return false, nil, nil
	})

	pods, err := client.ListPods(context.Background(), "", "n1", "default", "app=web,tier=frontend")
	if err != nil {
		t.Fatalf("ListPods: %v", err)
	}
	if len(pods) != 1 || pods[0].Name != "p1" {
		t.Fatalf("ListPods = %+v, want only p1", pods)
	}
	if gotFieldSelector != "spec.nodeName=n1" {
		t.Errorf("field selector = %q, want spec.nodeName=n1", gotFieldSelector)
	}

	detail, err := client.GetNode(context.Background(), "", "n1")
	if err != nil {
		t.Fatalf("GetNode: %v", err)
	}
	if detail.Name != "n1" || detail.Status != "Ready" || detail.Version != "v1.30.0" {
		t.Errorf("GetNode basic fields = %+v", detail)
	}
	if len(detail.Roles) != 1 || detail.Roles[0] != "control-plane" {
		t.Errorf("GetNode roles = %v", detail.Roles)
	}
	if detail.Capacity["cpu"] != "4" || detail.Capacity["memory"] != "16Gi" {
		t.Errorf("GetNode capacity = %v", detail.Capacity)
	}
	if detail.Allocatable["cpu"] != "4" || detail.Allocatable["memory"] != "16Gi" {
		t.Errorf("GetNode allocatable = %v", detail.Allocatable)
	}
	if len(detail.Conditions) != 1 || detail.Conditions[0].Type != "Ready" || detail.Conditions[0].Status != "True" {
		t.Errorf("GetNode conditions = %+v", detail.Conditions)
	}
	if len(detail.Addresses) != 1 || detail.Addresses[0].Type != "InternalIP" || detail.Addresses[0].Address != "10.0.0.1" {
		t.Errorf("GetNode addresses = %+v", detail.Addresses)
	}
}
