#!/bin/bash
# Agent Dev 环境部署脚本

set -e

GREEN='\033[0;32m'
BLUE='\033[0;34m'
RED='\033[0;31m'
NC='\033[0m'

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ ! -f "$SCRIPT_DIR/values.yaml" ]; then
  if [ -f "$SCRIPT_DIR/values.example.yaml" ]; then
    echo "Missing values.yaml. Copy values.example.yaml to values.yaml and edit it first."
  else
    echo "Missing values.yaml."
  fi
  exit 1
fi
MANIFESTS_DIR="$(dirname "$SCRIPT_DIR")/manifests"

get_value() {
  local key="$1"
  grep -E "^${key}:" values.yaml | head -1 | sed 's/^[^:]*:[[:space:]]*//' | sed 's/^"//' | sed 's/"$//'
}

APP_NAME=$(get_value "appName")
NAMESPACE=$(get_value "namespace")
SERVICE_NAME=$(get_value "serviceName")
PORT=$(get_value "port")
IMAGE=${OVERRIDE_IMAGE:-$(get_value "image")}
ENV=$(get_value "env")
LOG_LEVEL=$(get_value "logLevel")
WORKSPACE_ROOT=$(get_value "workspaceRoot")
CHECKPOINT_CACHE_ROOT=$(get_value "checkpointCacheRoot")
SESSIONS_DIR=$(get_value "sessionsDir")
PLATFORM_CONFIG_ROOT=$(get_value "platformConfigRoot")
SPACE_STORAGE_PVC=$(get_value "spaceStoragePvc")
CHECKPOINT_CACHE_PVC=$(get_value "checkpointCachePvc")
WORKSPACE_SUBPATH=$(get_value "workspaceSubpath")
CHECKPOINT_CACHE_SUBPATH=$(get_value "checkpointCacheSubpath")
SESSIONS_SUBPATH=$(get_value "sessionsSubpath")
CONFIGS_SUBPATH=$(get_value "configsSubpath")
SESSIONS_NAMESPACE=$(get_value "sessionsNamespace")
AGENT_WORKER_CONCURRENCY=$(get_value "agentWorkerConcurrency")
AGENT_SHUTDOWN_DRAIN_TIMEOUT_MS=$(get_value "agentShutdownDrainTimeoutMs")
TURN_OBJECT_S3_ENDPOINT=$(get_value "TURN_OBJECT_S3_ENDPOINT")
TURN_OBJECT_S3_REGION=$(get_value "TURN_OBJECT_S3_REGION")
TURN_OBJECT_S3_BUCKET=$(get_value "TURN_OBJECT_S3_BUCKET")
TURN_OBJECT_S3_TIMEOUT_MS=$(get_value "TURN_OBJECT_S3_TIMEOUT_MS")
TURN_OBJECT_S3_MAX_ATTEMPTS=$(get_value "TURN_OBJECT_S3_MAX_ATTEMPTS")
TURN_OBJECT_CDN_BASE_URL=$(get_value "TURN_OBJECT_CDN_BASE_URL")
REPLICAS=$(get_value "replicas")
MAX_UNAVAILABLE=$(get_value "maxUnavailable")
MAX_SURGE=$(get_value "maxSurge")
TERMINATION_GRACE_PERIOD_SECONDS=$(get_value "terminationGracePeriodSeconds")
IMAGE_PULL_POLICY=$(get_value "imagePullPolicy")
RESOURCE_REQUEST_CPU=$(get_value "resourceRequestCpu")
RESOURCE_REQUEST_MEMORY=$(get_value "resourceRequestMemory")
RESOURCE_LIMIT_CPU=$(get_value "resourceLimitCpu")
RESOURCE_LIMIT_MEMORY=$(get_value "resourceLimitMemory")

require_value() {
  local name="$1"
  local value="$2"
  if [ -z "$value" ]; then
    echo -e "${RED}✗ 缺少必填配置: ${name}${NC}"
    exit 1
  fi
}

require_value "appName" "$APP_NAME"
require_value "namespace" "$NAMESPACE"
require_value "serviceName" "$SERVICE_NAME"
require_value "port" "$PORT"
require_value "image" "$IMAGE"
require_value "env" "$ENV"
require_value "workspaceRoot" "$WORKSPACE_ROOT"
require_value "checkpointCacheRoot" "$CHECKPOINT_CACHE_ROOT"
require_value "sessionsDir" "$SESSIONS_DIR"
require_value "platformConfigRoot" "$PLATFORM_CONFIG_ROOT"
require_value "spaceStoragePvc" "$SPACE_STORAGE_PVC"
require_value "checkpointCachePvc" "$CHECKPOINT_CACHE_PVC"
require_value "workspaceSubpath" "$WORKSPACE_SUBPATH"
require_value "checkpointCacheSubpath" "$CHECKPOINT_CACHE_SUBPATH"
require_value "sessionsSubpath" "$SESSIONS_SUBPATH"
require_value "configsSubpath" "$CONFIGS_SUBPATH"
require_value "sessionsNamespace" "$SESSIONS_NAMESPACE"
require_value "agentWorkerConcurrency" "$AGENT_WORKER_CONCURRENCY"
require_value "agentShutdownDrainTimeoutMs" "$AGENT_SHUTDOWN_DRAIN_TIMEOUT_MS"
require_value "TURN_OBJECT_S3_ENDPOINT" "$TURN_OBJECT_S3_ENDPOINT"
require_value "TURN_OBJECT_S3_REGION" "$TURN_OBJECT_S3_REGION"
require_value "TURN_OBJECT_S3_BUCKET" "$TURN_OBJECT_S3_BUCKET"
require_value "TURN_OBJECT_S3_TIMEOUT_MS" "$TURN_OBJECT_S3_TIMEOUT_MS"
require_value "TURN_OBJECT_S3_MAX_ATTEMPTS" "$TURN_OBJECT_S3_MAX_ATTEMPTS"
require_value "TURN_OBJECT_CDN_BASE_URL" "$TURN_OBJECT_CDN_BASE_URL"
require_value "replicas" "$REPLICAS"
require_value "maxUnavailable" "$MAX_UNAVAILABLE"
require_value "maxSurge" "$MAX_SURGE"
require_value "terminationGracePeriodSeconds" "$TERMINATION_GRACE_PERIOD_SECONDS"
require_value "imagePullPolicy" "$IMAGE_PULL_POLICY"
require_value "resourceRequestCpu" "$RESOURCE_REQUEST_CPU"
require_value "resourceRequestMemory" "$RESOURCE_REQUEST_MEMORY"
require_value "resourceLimitCpu" "$RESOURCE_LIMIT_CPU"
require_value "resourceLimitMemory" "$RESOURCE_LIMIT_MEMORY"

if [ ! -f "secrets.yaml" ]; then
  echo -e "${RED}✗ 缺少 secrets.yaml，请先参考 secrets.template.yaml 生成${NC}"
  exit 1
fi

mkdir -p rendered
cp "$MANIFESTS_DIR/configmap.tmpl.yaml" rendered/configmap.yaml
cp "$MANIFESTS_DIR/service.tmpl.yaml" rendered/service.yaml
cp "$MANIFESTS_DIR/deployment.tmpl.yaml" rendered/deployment.yaml

sed -i.bak \
  -e "s|{{APP_NAME}}|${APP_NAME}|g" \
  -e "s|{{NAMESPACE}}|${NAMESPACE}|g" \
  -e "s|{{SERVICE_NAME}}|${SERVICE_NAME}|g" \
  -e "s|{{PORT}}|${PORT}|g" \
  -e "s|{{REPLICAS}}|${REPLICAS}|g" \
  -e "s|{{MAX_UNAVAILABLE}}|${MAX_UNAVAILABLE}|g" \
  -e "s|{{MAX_SURGE}}|${MAX_SURGE}|g" \
  -e "s|{{TERMINATION_GRACE_PERIOD_SECONDS}}|${TERMINATION_GRACE_PERIOD_SECONDS}|g" \
  rendered/configmap.yaml rendered/service.yaml rendered/deployment.yaml

sed -i.bak \
  -e "s|{{APP_NAME}}|${APP_NAME}|g" \
  -e "s|{{NAMESPACE}}|${NAMESPACE}|g" \
  -e "s|{{IMAGE}}|${IMAGE}|g" \
  -e "s|{{IMAGE_PULL_POLICY}}|${IMAGE_PULL_POLICY}|g" \
  -e "s|{{PORT}}|${PORT}|g" \
  -e "s|{{ENV}}|${ENV}|g" \
  -e "s|{{LOG_LEVEL}}|${LOG_LEVEL:-info}|g" \
  -e "s|{{WORKSPACE_ROOT}}|${WORKSPACE_ROOT}|g" \
  -e "s|{{CHECKPOINT_CACHE_ROOT}}|${CHECKPOINT_CACHE_ROOT}|g" \
  -e "s|{{SESSIONS_DIR}}|${SESSIONS_DIR}|g" \
  -e "s|{{SESSIONS_NAMESPACE}}|${SESSIONS_NAMESPACE}|g" \
  -e "s|{{AGENT_WORKER_CONCURRENCY}}|${AGENT_WORKER_CONCURRENCY}|g" \
  -e "s|{{AGENT_SHUTDOWN_DRAIN_TIMEOUT_MS}}|${AGENT_SHUTDOWN_DRAIN_TIMEOUT_MS}|g" \
  -e "s|{{PLATFORM_CONFIG_ROOT}}|${PLATFORM_CONFIG_ROOT}|g" \
  -e "s|{{TURN_OBJECT_S3_ENDPOINT}}|${TURN_OBJECT_S3_ENDPOINT}|g" \
  -e "s|{{TURN_OBJECT_S3_REGION}}|${TURN_OBJECT_S3_REGION}|g" \
  -e "s|{{TURN_OBJECT_S3_BUCKET}}|${TURN_OBJECT_S3_BUCKET}|g" \
  -e "s|{{TURN_OBJECT_S3_TIMEOUT_MS}}|${TURN_OBJECT_S3_TIMEOUT_MS}|g" \
  -e "s|{{TURN_OBJECT_S3_MAX_ATTEMPTS}}|${TURN_OBJECT_S3_MAX_ATTEMPTS}|g" \
  -e "s|{{TURN_OBJECT_CDN_BASE_URL}}|${TURN_OBJECT_CDN_BASE_URL}|g" \
  -e "s|{{SPACE_STORAGE_PVC}}|${SPACE_STORAGE_PVC}|g" \
  -e "s|{{CHECKPOINT_CACHE_PVC}}|${CHECKPOINT_CACHE_PVC}|g" \
  -e "s|{{WORKSPACE_SUBPATH}}|${WORKSPACE_SUBPATH}|g" \
  -e "s|{{CHECKPOINT_CACHE_SUBPATH}}|${CHECKPOINT_CACHE_SUBPATH}|g" \
  -e "s|{{SESSIONS_SUBPATH}}|${SESSIONS_SUBPATH}|g" \
  -e "s|{{CONFIGS_SUBPATH}}|${CONFIGS_SUBPATH}|g" \
  rendered/configmap.yaml rendered/deployment.yaml

# Inject resource limits
awk -v request_cpu="$RESOURCE_REQUEST_CPU" \
    -v request_memory="$RESOURCE_REQUEST_MEMORY" \
    -v limit_cpu="$RESOURCE_LIMIT_CPU" \
    -v limit_memory="$RESOURCE_LIMIT_MEMORY" \
    '/{{RESOURCES}}/ {
  print "          resources:"
  print "            requests:"
  print "              cpu: \"" request_cpu "\""
  print "              memory: \"" request_memory "\""
  print "            limits:"
  print "              cpu: \"" limit_cpu "\""
  print "              memory: \"" limit_memory "\""
  next
}
{ print }' rendered/deployment.yaml > rendered/deployment.tmp && mv rendered/deployment.tmp rendered/deployment.yaml

rm -f rendered/*.bak

kubectl apply -f secrets.yaml
kubectl apply -f rendered/configmap.yaml
kubectl apply -f rendered/service.yaml
kubectl apply -f rendered/deployment.yaml

echo -e "${BLUE}Agent dev deployment rendered and applied.${NC}"
echo -e "${GREEN}✅ Deploy finished${NC}"
