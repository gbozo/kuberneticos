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

package client

import (
	"errors"
	"log"
	"strings"

	restful "github.com/emicklei/go-restful"
	v1 "k8s.io/api/authorization/v1"
	errorsK8s "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"
	"k8s.io/client-go/tools/clientcmd"
	"k8s.io/client-go/tools/clientcmd/api"

	"github.com/gbozo/kuberneticos/args"
	authApi "github.com/gbozo/kuberneticos/auth/api"
	clientapi "github.com/gbozo/kuberneticos/client/api"
	"github.com/gbozo/kuberneticos/client/csrf"
	kdErrors "github.com/gbozo/kuberneticos/errors"
)

// Dashboard UI default values for client configs.
const (
	// High enough QPS to fit all expected use cases. QPS=0 is not set here, because
	// client code is overriding it.
	DefaultQPS = 1e6
	// High enough Burst to fit all expected use cases. Burst=0 is not set here, because
	// client code is overriding it.
	DefaultBurst = 1e6
	// Use kubernetes protobuf as content type by default
	DefaultContentType = "application/vnd.kubernetes.protobuf"
	// Default cluster/context/auth name to be set in clientcmd config
	DefaultCmdConfigName = "kubernetes"
	// Header name that contains token used for authorization. See TokenManager for more information.
	JWETokenHeader = "jweToken"
	// Default http header for user-agent
	DefaultUserAgent = "dashboard"
)

// VERSION of this binary
var Version = "UNKNOWN"

// clientManager implements ClientManager interface
type clientManager struct {
	// Autogenerated key on backend start used to secure requests from csrf attacks
	csrfKey string
	// Path to kubeconfig file. If both kubeConfigPath and apiserverHost are empty
	// inClusterConfig will be used
	kubeConfigPath string
	// Address of apiserver host in format 'protocol://address:port'
	apiserverHost string
	// Initialized on clientManager creation and used if kubeconfigPath and apiserverHost are
	// empty
	inClusterConfig *rest.Config
	// Responsible for decrypting tokens coming in request header. Used for authentication.
	tokenManager authApi.TokenManager
	// Kubernetes client created without providing auth info. It uses permissions granted to
	// service account used by dashboard or kubeconfig file if it was passed during dashboard init.
	insecureClient kubernetes.Interface
	// Kubernetes client config created without providing auth info. It uses permissions granted
	// to service account used by dashboard or kubeconfig file if it was passed during dashboard
	// init.
	insecureConfig *rest.Config
}

// Client returns a kubernetes client. In case dashboard login is enabled and option to skip
// login page is disabled only secure client will be returned, otherwise insecure client will be
// used.
func (self *clientManager) Client(req *restful.Request) (kubernetes.Interface, error) {
	if req == nil {
		return nil, errors.New("Request can not be nil!")
	}

	if self.isSecureModeEnabled(req) {
		return self.secureClient(req)
	}

	return self.InsecureClient(), nil
}

// Config returns a rest config. In case dashboard login is enabled and option to skip
// login page is disabled only secure config will be returned, otherwise insecure config will be
// used.
func (self *clientManager) Config(req *restful.Request) (*rest.Config, error) {
	if req == nil {
		return nil, errors.New("Request can not be nil!")
	}

	if self.isSecureModeEnabled(req) {
		return self.secureConfig(req)
	}

	return self.InsecureConfig(), nil
}

// InsecureClient returns kubernetes client that was created without providing auth info. It uses
// permissions granted to service account used by dashboard or kubeconfig file if it was passed
// during dashboard init.
func (self *clientManager) InsecureClient() kubernetes.Interface {
	return self.insecureClient
}

// InsecureConfig returns kubernetes client config that used privileges of dashboard service account
// or kubeconfig file if it was passed during dashboard init.
func (self *clientManager) InsecureConfig() *rest.Config {
	return self.insecureConfig
}

// CanI returns true when user is allowed to access data provided within SelfSubjectAccessReview, false otherwise.
func (self *clientManager) CanI(req *restful.Request, ssar *v1.SelfSubjectAccessReview) bool {
	// In case user is not authenticated (uses skip option) do not allow access.
	info, _ := self.extractAuthInfo(req)
	if info == nil && len(args.Holder.GetCertFile()) > 0 && len(args.Holder.GetKeyFile()) > 0 {
		return false
	}

	client, err := self.Client(req)
	if err != nil {
		log.Println(err)
		return false
	}

	response, err := client.AuthorizationV1().SelfSubjectAccessReviews().Create(ssar)
	if err != nil {
		log.Println(err)
		return false
	}

	return response.Status.Allowed
}

// ClientCmdConfig creates ClientCmd Config based on authentication information extracted from request.
// Currently request header is only checked for existence of 'Authentication: BearerToken'
func (self *clientManager) ClientCmdConfig(req *restful.Request) (clientcmd.ClientConfig, error) {
	authInfo, err := self.extractAuthInfo(req)
	if err != nil {
		return nil, err
	}

	cfg, err := self.buildConfigFromFlags(self.apiserverHost, self.kubeConfigPath)
	if err != nil {
		return nil, err
	}

	return self.buildCmdConfig(authInfo, cfg), nil
}

// CSRFKey returns key that is generated upon client manager creation
func (self *clientManager) CSRFKey() string {
	return self.csrfKey
}

// HasAccess configures K8S api client with provided auth info and executes a basic check against apiserver to see
// if it is valid.
func (self *clientManager) HasAccess(authInfo api.AuthInfo) error {
	cfg, err := self.buildConfigFromFlags(self.apiserverHost, self.kubeConfigPath)
	if err != nil {
		return err
	}

	clientConfig := self.buildCmdConfig(&authInfo, cfg)
	cfg, err = clientConfig.ClientConfig()
	if err != nil {
		return err
	}

	client, err := kubernetes.NewForConfig(cfg)
	if err != nil {
		return err
	}

	_, err = client.ServerVersion()
	return err
}

// VerberClient returns new verber client based on authentication information extracted from request
func (self *clientManager) VerberClient(req *restful.Request) (clientapi.ResourceVerber, error) {
	client, err := self.Client(req)
	if err != nil {
		return nil, err
	}

	return NewResourceVerber(client.CoreV1().RESTClient(),
		client.ExtensionsV1beta1().RESTClient(), client.AppsV1beta2().RESTClient(),
		client.BatchV1().RESTClient(), client.BatchV1beta1().RESTClient(), client.AutoscalingV1().RESTClient(),
		client.StorageV1().RESTClient(), client.RbacV1().RESTClient()), nil
}

// SetTokenManager sets the token manager that will be used for token decryption.
func (self *clientManager) SetTokenManager(manager authApi.TokenManager) {
	self.tokenManager = manager
}

// Initializes config with default values
func (self *clientManager) initConfig(cfg *rest.Config) {
	cfg.QPS = DefaultQPS
	cfg.Burst = DefaultBurst
	cfg.ContentType = DefaultContentType
	cfg.UserAgent = DefaultUserAgent + "/" + Version
}

// Returns rest Config based on provided apiserverHost and kubeConfigPath flags. If both are
// empty then in-cluster config will be used and if it is nil the error is returned.
func (self *clientManager) buildConfigFromFlags(apiserverHost, kubeConfigPath string) (
	*rest.Config, error) {
	if len(kubeConfigPath) > 0 || len(apiserverHost) > 0 {
		return clientcmd.NewNonInteractiveDeferredLoadingClientConfig(
			&clientcmd.ClientConfigLoadingRules{ExplicitPath: kubeConfigPath},
			&clientcmd.ConfigOverrides{ClusterInfo: api.Cluster{Server: apiserverHost}}).ClientConfig()
	}

	if self.isRunningInCluster() {
		return self.inClusterConfig, nil
	}

	return nil, errors.New("could not create client config")
}

// Based on auth info and rest config creates client cmd config.
func (self *clientManager) buildCmdConfig(authInfo *api.AuthInfo, cfg *rest.Config) clientcmd.ClientConfig {
	cmdCfg := api.NewConfig()
	cmdCfg.Clusters[DefaultCmdConfigName] = &api.Cluster{
		Server:                   cfg.Host,
		CertificateAuthority:     cfg.TLSClientConfig.CAFile,
		CertificateAuthorityData: cfg.TLSClientConfig.CAData,
		InsecureSkipTLSVerify:    cfg.TLSClientConfig.Insecure,
	}
	cmdCfg.AuthInfos[DefaultCmdConfigName] = authInfo
	cmdCfg.Contexts[DefaultCmdConfigName] = &api.Context{
		Cluster:  DefaultCmdConfigName,
		AuthInfo: DefaultCmdConfigName,
	}
	cmdCfg.CurrentContext = DefaultCmdConfigName

	return clientcmd.NewDefaultClientConfig(
		*cmdCfg,
		&clientcmd.ConfigOverrides{},
	)
}

// Extracts authorization information from the request header
func (self *clientManager) extractAuthInfo(req *restful.Request) (*api.AuthInfo, error) {
	authHeader := req.HeaderParameter("Authorization")
	jweToken := req.HeaderParameter(JWETokenHeader)

	// Authorization header will be more important than our token
	token := self.extractTokenFromHeader(authHeader)
	if len(token) > 0 {
		return &api.AuthInfo{Token: token}, nil
	}

	if self.tokenManager != nil && len(jweToken) > 0 {
		return self.tokenManager.Decrypt(jweToken)
	}

	return nil, errorsK8s.NewUnauthorized(kdErrors.MSG_LOGIN_UNAUTHORIZED_ERROR)
}

func (self *clientManager) extractTokenFromHeader(authHeader string) string {
	if strings.HasPrefix(authHeader, "Bearer ") {
		return strings.TrimPrefix(authHeader, "Bearer ")
	}

	return ""
}

func (self *clientManager) isLoginEnabled(req *restful.Request) bool {
	return req.Request.TLS != nil || args.Holder.GetEnableInsecureLogin()
}

// Secure mode means that every request to Dashboard has to be authenticated and privileges
// of Dashboard SA can not be used.
func (self *clientManager) isSecureModeEnabled(req *restful.Request) bool {
	if self.isLoginEnabled(req) && !args.Holder.GetEnableSkipLogin() {
		return true
	}

	authInfo, _ := self.extractAuthInfo(req)
	return self.isLoginEnabled(req) && args.Holder.GetEnableSkipLogin() && authInfo != nil
}

func (self *clientManager) secureClient(req *restful.Request) (kubernetes.Interface, error) {
	cfg, err := self.secureConfig(req)
	if err != nil {
		return nil, err
	}

	client, err := kubernetes.NewForConfig(cfg)
	if err != nil {
		return nil, err
	}

	return client, nil
}

func (self *clientManager) secureConfig(req *restful.Request) (*rest.Config, error) {
	cmdConfig, err := self.ClientCmdConfig(req)
	if err != nil {
		return nil, err
	}

	cfg, err := cmdConfig.ClientConfig()
	if err != nil {
		return nil, err
	}

	self.initConfig(cfg)
	return cfg, nil
}

// Initializes client manager
func (self *clientManager) init() {
	self.initInClusterConfig()
	self.initInsecureClient()
	self.initCSRFKey()
}

// Initializes in-cluster config if apiserverHost and kubeConfigPath were not provided.
func (self *clientManager) initInClusterConfig() {
	if len(self.apiserverHost) > 0 || len(self.kubeConfigPath) > 0 {
		log.Print("Skipping in-cluster config")
		return
	}

	log.Print("Using in-cluster config to connect to apiserver")
	cfg, err := rest.InClusterConfig()
	if err != nil {
		log.Printf("Could not init in cluster config: %s", err.Error())
		return
	}

	self.inClusterConfig = cfg
}

// Initializes csrfKey. If in-cluster config is detected then csrf key is initialized with
// service account token, otherwise it is generated
func (self *clientManager) initCSRFKey() {
	if self.inClusterConfig == nil {
		// Most likely running for a dev, so no replica issues, just generate a random key
		log.Println("Using random key for csrf signing")
		self.csrfKey = clientapi.GenerateCSRFKey()
		return
	}

	// We run in a cluster, so we should use a signing key that is the same for potential replications
	log.Println("Using secret token for csrf signing")
	self.csrfKey = csrf.NewCsrfTokenManager(self.insecureClient).Token()
}

func (self *clientManager) initInsecureClient() {
	self.initInsecureConfig()
	client, err := kubernetes.NewForConfig(self.insecureConfig)
	if err != nil {
		panic(err)
	}

	self.insecureClient = client
}

func (self *clientManager) initInsecureConfig() {
	cfg, err := self.buildConfigFromFlags(self.apiserverHost, self.kubeConfigPath)
	if err != nil {
		panic(err)
	}

	self.initConfig(cfg)
	self.insecureConfig = cfg
}

// Returns true if in-cluster config is used
func (self *clientManager) isRunningInCluster() bool {
	return self.inClusterConfig != nil
}

// NewClientManager creates client manager based on kubeConfigPath and apiserverHost parameters.
// If both are empty then in-cluster config is used.
func NewClientManager(kubeConfigPath, apiserverHost string) clientapi.ClientManager {
	result := &clientManager{
		kubeConfigPath: kubeConfigPath,
		apiserverHost:  apiserverHost,
	}

	result.init()
	return result
}
