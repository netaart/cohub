#!/bin/bash
# Prod 环境部署脚本

set -e

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
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

NAMESPACE=$(get_value "NAMESPACE")
APP_NAME=$(get_value "APP_NAME")
IMAGE_REPOSITORY=$(get_value "IMAGE_REPOSITORY")
IMAGE_TAG=${OVERRIDE_IMAGE_TAG:-$(get_value "IMAGE_TAG")}
IMAGE_PULL_POLICY=$(get_value "IMAGE_PULL_POLICY")
IMAGE_PULL_SECRET=$(get_value "IMAGE_PULL_SECRET")
SERVICE_PORT=$(get_value "SERVICE_PORT")
CONTAINER_PORT=$(get_value "CONTAINER_PORT")
REPLICAS=$(get_value "REPLICAS")
MAX_UNAVAILABLE=$(get_value "MAX_UNAVAILABLE")
MAX_SURGE=$(get_value "MAX_SURGE")
TERMINATION_GRACE_PERIOD_SECONDS=$(get_value "TERMINATION_GRACE_PERIOD_SECONDS")
REQUEST_CPU=$(get_value "REQUEST_CPU")
REQUEST_MEMORY=$(get_value "REQUEST_MEMORY")
LIMIT_CPU=$(get_value "LIMIT_CPU")
LIMIT_MEMORY=$(get_value "LIMIT_MEMORY")
LIVENESS_PATH=$(get_value "LIVENESS_PATH")
LIVENESS_INITIAL_DELAY=$(get_value "LIVENESS_INITIAL_DELAY")
LIVENESS_PERIOD=$(get_value "LIVENESS_PERIOD")
LIVENESS_TIMEOUT=$(get_value "LIVENESS_TIMEOUT")
LIVENESS_FAILURE_THRESHOLD=$(get_value "LIVENESS_FAILURE_THRESHOLD")
READINESS_PATH=$(get_value "READINESS_PATH")
READINESS_INITIAL_DELAY=$(get_value "READINESS_INITIAL_DELAY")
READINESS_PERIOD=$(get_value "READINESS_PERIOD")
READINESS_TIMEOUT=$(get_value "READINESS_TIMEOUT")
READINESS_FAILURE_THRESHOLD=$(get_value "READINESS_FAILURE_THRESHOLD")
LOGTO_ENDPOINT=$(get_value "LOGTO_ENDPOINT")
LOGTO_MANAGEMENT_API_RESOURCE=$(get_value "LOGTO_MANAGEMENT_API_RESOURCE")
GITEA_BASE_URL=$(get_value "GITEA_BASE_URL")
GITEA_MANAGED_EMAIL_DOMAIN=$(get_value "GITEA_MANAGED_EMAIL_DOMAIN")
WEB_ORIGIN=$(get_value "WEB_ORIGIN")
ROUTER_STATUS_URL=$(get_value "ROUTER_STATUS_URL")
SANDBOX_IMAGE=${OVERRIDE_SANDBOX_IMAGE:-$(get_value "SANDBOX_IMAGE")}
SANDBOX_SEARCH_ENABLED=$(get_value "SANDBOX_SEARCH_ENABLED")
SANDBOX_SEARCH_VERSION=$(get_value "SANDBOX_SEARCH_VERSION")
SANDBOX_SEARCH_CDN_BASE_URL=$(get_value "SANDBOX_SEARCH_CDN_BASE_URL")
SPACE_STORAGE_ROOT=$(get_value "SPACE_STORAGE_ROOT")
SPACE_SYSTEM_ROOT=$(get_value "SPACE_SYSTEM_ROOT")
SPACE_STORAGE_PVC=$(get_value "SPACE_STORAGE_PVC")
SPACE_SYSTEM_PVC=$(get_value "SPACE_SYSTEM_PVC")
CHECKPOINT_CACHE_PVC=$(get_value "CHECKPOINT_CACHE_PVC")
SPACE_STORAGE_SUBPATH=$(get_value "SPACE_STORAGE_SUBPATH")
SPACE_SYSTEM_SUBPATH=$(get_value "SPACE_SYSTEM_SUBPATH")
CHECKPOINT_CACHE_SUBPATH=$(get_value "CHECKPOINT_CACHE_SUBPATH")
PLATFORM_CONFIG_ROOT=$(get_value "PLATFORM_CONFIG_ROOT")
TURN_OBJECT_S3_ENDPOINT=$(get_value "TURN_OBJECT_S3_ENDPOINT")
TURN_OBJECT_S3_REGION=$(get_value "TURN_OBJECT_S3_REGION")
TURN_OBJECT_S3_BUCKET=$(get_value "TURN_OBJECT_S3_BUCKET")
TURN_OBJECT_CDN_BASE_URL=$(get_value "TURN_OBJECT_CDN_BASE_URL")
PUBLIC_ASSET_OSS_ENDPOINT=$(get_value "PUBLIC_ASSET_OSS_ENDPOINT")
PUBLIC_ASSET_OSS_PUBLIC_ENDPOINT=$(get_value "PUBLIC_ASSET_OSS_PUBLIC_ENDPOINT")
PUBLIC_ASSET_OSS_REGION=$(get_value "PUBLIC_ASSET_OSS_REGION")
PUBLIC_ASSET_OSS_BUCKET=$(get_value "PUBLIC_ASSET_OSS_BUCKET")
PUBLIC_ASSET_CDN_BASE_URL=$(get_value "PUBLIC_ASSET_CDN_BASE_URL")
USER_UPLOAD_S3_ENDPOINT=$(get_value "USER_UPLOAD_S3_ENDPOINT")
USER_UPLOAD_S3_REGION=$(get_value "USER_UPLOAD_S3_REGION")
CHAT_ATTACHMENT_S3_BUCKET=$(get_value "CHAT_ATTACHMENT_S3_BUCKET")
CHAT_ATTACHMENT_PUBLIC_BASE_URL=$(get_value "CHAT_ATTACHMENT_PUBLIC_BASE_URL")
SPACE_UPLOAD_S3_BUCKET=$(get_value "SPACE_UPLOAD_S3_BUCKET")
APP_ASSET_CDN_BASE_URL=$(get_value "APP_ASSET_CDN_BASE_URL" || get_value "WORK_ASSET_CDN_BASE_URL")
CONFIGS_SUBPATH=$(get_value "CONFIGS_SUBPATH")
SANDBOX_PUBLIC_DOMAINS=$(get_value "SANDBOX_PUBLIC_DOMAINS")
APP_CONTENT_HOST_SUFFIXES=$(get_value "APP_CONTENT_HOST_SUFFIXES" || get_value "WORK_CONTENT_HOST_SUFFIXES")
APP_STANDALONE_HOST_TEMPLATE=$(get_value "APP_STANDALONE_HOST_TEMPLATE")
CHECKPOINT_GIT_AUTHOR_EMAIL=$(get_value "CHECKPOINT_GIT_AUTHOR_EMAIL")
ROUTE_ENABLED=$(get_value "ROUTE_ENABLED")
API_HOSTNAMES=$(get_value "API_HOSTNAMES")
if [ -z "$API_HOSTNAMES" ]; then
  API_HOSTNAMES=$(get_value "API_HOSTNAME")
fi
ENV=$(get_value "ENV")
LOG_LEVEL=$(get_value "LOG_LEVEL")

echo -e "${BLUE}╔════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║   Cohub API Prod 环境部署        ║${NC}"
echo -e "${BLUE}╚════════════════════════════════════════╝${NC}"

if [ ! -f "secrets.yaml" ]; then
  echo -e "${RED}✗ 缺少 secrets.yaml${NC}"
  exit 1
fi
kubectl apply -f secrets.yaml

mkdir -p rendered

render_template() {
  local src="$1"
  local dst="$2"

  cp "$src" "$dst"

  python - "$dst" "$IMAGE_PULL_SECRET" "$API_HOSTNAMES" <<'PY'
from pathlib import Path
import re
import sys
path = Path(sys.argv[1])
secret = sys.argv[2]
hostnames = [value.strip().lower() for value in sys.argv[3].split(",") if value.strip()]
text = path.read_text()
secret_placeholder = "__IMAGE_PULL_SECRETS_BLOCK__\n"
if secret_placeholder in text:
    replacement = ""
    if secret:
        replacement = f"      imagePullSecrets:\n        - name: {secret}\n"
    text = text.replace(secret_placeholder, replacement)
hostnames_placeholder = "__HOSTNAMES_BLOCK__\n"
if hostnames_placeholder in text:
    if not hostnames:
        raise SystemExit("At least one API hostname is required")
    if any(not re.fullmatch(r"[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?", host) or ".." in host for host in hostnames):
        raise SystemExit("Invalid API hostname")
    text = text.replace(hostnames_placeholder, "".join(f'    - "{host}"\n' for host in dict.fromkeys(hostnames)))
path.write_text(text)
PY

  sed -i.bak \
    -e "s|__NAMESPACE__|${NAMESPACE}|g" \
    -e "s|__APP_NAME__|${APP_NAME}|g" \
    -e "s|__IMAGE_REPOSITORY__|${IMAGE_REPOSITORY}|g" \
    -e "s|__IMAGE_TAG__|${IMAGE_TAG}|g" \
    -e "s|__IMAGE_PULL_POLICY__|${IMAGE_PULL_POLICY}|g" \
    -e "s|__SERVICE_PORT__|${SERVICE_PORT}|g" \
    -e "s|__CONTAINER_PORT__|${CONTAINER_PORT}|g" \
    -e "s|__REPLICAS__|${REPLICAS}|g" \
    -e "s|__MAX_UNAVAILABLE__|${MAX_UNAVAILABLE}|g" \
    -e "s|__MAX_SURGE__|${MAX_SURGE}|g" \
    -e "s|__TERMINATION_GRACE_PERIOD_SECONDS__|${TERMINATION_GRACE_PERIOD_SECONDS}|g" \
    -e "s|__REQUEST_CPU__|${REQUEST_CPU}|g" \
    -e "s|__REQUEST_MEMORY__|${REQUEST_MEMORY}|g" \
    -e "s|__LIMIT_CPU__|${LIMIT_CPU}|g" \
    -e "s|__LIMIT_MEMORY__|${LIMIT_MEMORY}|g" \
    -e "s|__LIVENESS_PATH__|${LIVENESS_PATH}|g" \
    -e "s|__LIVENESS_INITIAL_DELAY__|${LIVENESS_INITIAL_DELAY}|g" \
    -e "s|__LIVENESS_PERIOD__|${LIVENESS_PERIOD}|g" \
    -e "s|__LIVENESS_TIMEOUT__|${LIVENESS_TIMEOUT}|g" \
    -e "s|__LIVENESS_FAILURE_THRESHOLD__|${LIVENESS_FAILURE_THRESHOLD}|g" \
    -e "s|__READINESS_PATH__|${READINESS_PATH}|g" \
    -e "s|__READINESS_INITIAL_DELAY__|${READINESS_INITIAL_DELAY}|g" \
    -e "s|__READINESS_PERIOD__|${READINESS_PERIOD}|g" \
    -e "s|__READINESS_TIMEOUT__|${READINESS_TIMEOUT}|g" \
    -e "s|__READINESS_FAILURE_THRESHOLD__|${READINESS_FAILURE_THRESHOLD}|g" \
    -e "s|__LOGTO_ENDPOINT__|${LOGTO_ENDPOINT}|g" \
    -e "s|__LOGTO_MANAGEMENT_API_RESOURCE__|${LOGTO_MANAGEMENT_API_RESOURCE}|g" \
    -e "s|__GITEA_BASE_URL__|${GITEA_BASE_URL}|g" \
    -e "s|__GITEA_MANAGED_EMAIL_DOMAIN__|${GITEA_MANAGED_EMAIL_DOMAIN}|g" \
    -e "s|__WEB_ORIGIN__|${WEB_ORIGIN}|g" \
    -e "s|__ROUTER_STATUS_URL__|${ROUTER_STATUS_URL}|g" \
    -e "s|__SANDBOX_IMAGE__|${SANDBOX_IMAGE}|g" \
    -e "s|__SANDBOX_SEARCH_ENABLED__|${SANDBOX_SEARCH_ENABLED}|g" \
    -e "s|__SANDBOX_SEARCH_VERSION__|${SANDBOX_SEARCH_VERSION}|g" \
    -e "s|__SANDBOX_SEARCH_CDN_BASE_URL__|${SANDBOX_SEARCH_CDN_BASE_URL}|g" \
    -e "s|__SPACE_STORAGE_ROOT__|${SPACE_STORAGE_ROOT}|g" \
    -e "s|__SPACE_SYSTEM_ROOT__|${SPACE_SYSTEM_ROOT}|g" \
    -e "s|__SPACE_STORAGE_PVC__|${SPACE_STORAGE_PVC}|g" \
    -e "s|__SPACE_SYSTEM_PVC__|${SPACE_SYSTEM_PVC}|g" \
    -e "s|__CHECKPOINT_CACHE_PVC__|${CHECKPOINT_CACHE_PVC}|g" \
    -e "s|__SPACE_STORAGE_SUBPATH__|${SPACE_STORAGE_SUBPATH}|g" \
    -e "s|__SPACE_SYSTEM_SUBPATH__|${SPACE_SYSTEM_SUBPATH}|g" \
    -e "s|__CHECKPOINT_CACHE_SUBPATH__|${CHECKPOINT_CACHE_SUBPATH}|g" \
    -e "s|__PLATFORM_CONFIG_ROOT__|${PLATFORM_CONFIG_ROOT}|g" \
    -e "s|__TURN_OBJECT_S3_ENDPOINT__|${TURN_OBJECT_S3_ENDPOINT}|g" \
    -e "s|__TURN_OBJECT_S3_REGION__|${TURN_OBJECT_S3_REGION}|g" \
    -e "s|__TURN_OBJECT_S3_BUCKET__|${TURN_OBJECT_S3_BUCKET}|g" \
    -e "s|__TURN_OBJECT_CDN_BASE_URL__|${TURN_OBJECT_CDN_BASE_URL}|g" \
    -e "s|__PUBLIC_ASSET_OSS_ENDPOINT__|${PUBLIC_ASSET_OSS_ENDPOINT}|g" \
    -e "s|__PUBLIC_ASSET_OSS_PUBLIC_ENDPOINT__|${PUBLIC_ASSET_OSS_PUBLIC_ENDPOINT}|g" \
    -e "s|__PUBLIC_ASSET_OSS_REGION__|${PUBLIC_ASSET_OSS_REGION}|g" \
    -e "s|__PUBLIC_ASSET_OSS_BUCKET__|${PUBLIC_ASSET_OSS_BUCKET}|g" \
    -e "s|__PUBLIC_ASSET_CDN_BASE_URL__|${PUBLIC_ASSET_CDN_BASE_URL}|g" \
    -e "s|__USER_UPLOAD_S3_ENDPOINT__|${USER_UPLOAD_S3_ENDPOINT}|g" \
    -e "s|__USER_UPLOAD_S3_REGION__|${USER_UPLOAD_S3_REGION}|g" \
    -e "s|__CHAT_ATTACHMENT_S3_BUCKET__|${CHAT_ATTACHMENT_S3_BUCKET}|g" \
    -e "s|__CHAT_ATTACHMENT_PUBLIC_BASE_URL__|${CHAT_ATTACHMENT_PUBLIC_BASE_URL}|g" \
    -e "s|__SPACE_UPLOAD_S3_BUCKET__|${SPACE_UPLOAD_S3_BUCKET}|g" \
    -e "s|__APP_ASSET_CDN_BASE_URL__|${APP_ASSET_CDN_BASE_URL}|g" \
    -e "s|__CONFIGS_SUBPATH__|${CONFIGS_SUBPATH}|g" \
    -e "s|__SANDBOX_PUBLIC_DOMAINS__|${SANDBOX_PUBLIC_DOMAINS}|g" \
    -e "s|__APP_CONTENT_HOST_SUFFIXES__|${APP_CONTENT_HOST_SUFFIXES}|g" \
    -e "s|__APP_STANDALONE_HOST_TEMPLATE__|${APP_STANDALONE_HOST_TEMPLATE}|g" \
    -e "s|__CHECKPOINT_GIT_AUTHOR_EMAIL__|${CHECKPOINT_GIT_AUTHOR_EMAIL}|g" \
    -e "s|__ENV__|${ENV}|g" \
    -e "s|__LOG_LEVEL__|${LOG_LEVEL:-info}|g" \
    "$dst"
  rm -f "$dst.bak"
}

render_template "$MANIFESTS_DIR/configmap.tmpl.yaml" rendered/configmap.yaml
render_template "$MANIFESTS_DIR/deployment.tmpl.yaml" rendered/deployment.yaml
render_template "$MANIFESTS_DIR/service.tmpl.yaml" rendered/service.yaml

kubectl apply -f rendered/configmap.yaml
kubectl apply -f rendered/service.yaml
kubectl apply -f rbac.yaml
kubectl apply -f rendered/deployment.yaml

if [ "$ROUTE_ENABLED" = "true" ]; then
  render_template "$MANIFESTS_DIR/httproute.tmpl.yaml" rendered/httproute.yaml
  kubectl apply -f rendered/httproute.yaml
fi

echo ""
echo -e "${GREEN}✅ Prod 环境部署完成${NC}"
echo ""
echo "查看状态："
echo "  kubectl get pods -n ${NAMESPACE} -l app.kubernetes.io/name=${APP_NAME}"
echo "  kubectl get svc -n ${NAMESPACE} ${APP_NAME}"
echo "  kubectl logs -n ${NAMESPACE} -l app.kubernetes.io/name=${APP_NAME} -f"
