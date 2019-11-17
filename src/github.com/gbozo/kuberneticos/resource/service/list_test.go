// Copyright 2017 The Kubernetes Authors.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

package service

import (
	"reflect"
	"testing"

	"github.com/gbozo/kuberneticos/api"
	"github.com/gbozo/kuberneticos/resource/common"
	"github.com/gbozo/kuberneticos/resource/dataselect"
	v1 "k8s.io/api/core/v1"
	metaV1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes/fake"
)

func TestGetServiceList(t *testing.T) {
	cases := []struct {
		serviceList     *v1.ServiceList
		expectedActions []string
		expected        *ServiceList
	}{
		{
			serviceList: &v1.ServiceList{
				Items: []v1.Service{
					{ObjectMeta: metaV1.ObjectMeta{
						Name: "svc-1", Namespace: "ns-1",
						Labels: map[string]string{},
					}},
				}},
			expectedActions: []string{"list"},
			expected: &ServiceList{
				ListMeta: api.ListMeta{TotalItems: 1},
				Services: []Service{
					{
						ObjectMeta: api.ObjectMeta{
							Name:      "svc-1",
							Namespace: "ns-1",
							Labels:    map[string]string{},
						},
						TypeMeta:          api.TypeMeta{Kind: api.ResourceKindService},
						InternalEndpoint:  common.Endpoint{Host: "svc-1.ns-1"},
						ExternalEndpoints: []common.Endpoint{},
					},
				},
				Errors: []error{},
			},
		},
	}

	for _, c := range cases {
		fakeClient := fake.NewSimpleClientset(c.serviceList)
		actual, _ := GetServiceList(fakeClient, common.NewNamespaceQuery(nil), dataselect.NoDataSelect)
		actions := fakeClient.Actions()

		if len(actions) != len(c.expectedActions) {
			t.Errorf("Unexpected actions: %v, expected %d actions got %d", actions,
				len(c.expectedActions), len(actions))
			continue
		}

		for i, verb := range c.expectedActions {
			if actions[i].GetVerb() != verb {
				t.Errorf("Unexpected action: %+v, expected %s",
					actions[i], verb)
			}
		}

		if !reflect.DeepEqual(actual, c.expected) {
			t.Errorf("GetServiceList(client) == got\n%#v, expected\n %#v", actual, c.expected)
		}
	}
}