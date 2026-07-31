#!/usr/bin/env bash
set -Eeuo pipefail

# Reproducible Tencent Cloud Lighthouse deployment.
REPOSITORY_URL="${REPOSITORY_URL:-https://github.com/xcq403658606-ai/figma-cmyk-api.git}"
APP_REVISION="${APP_REVISION:-main}"
APP_DIRECTORY="${APP_DIRECTORY:-/opt/edc-box-api}"
IMAGE_NAME="${IMAGE_NAME:-edc-box-api}"
CONTAINER_NAME="${CONTAINER_NAME:-edc-box-api-next}"
HOST_PORT="${HOST_PORT:-8787}"
REGION="${REGION:-ap-shanghai}"
ALLOWED_ORIGINS="${ALLOWED_ORIGINS:-https://www.figma.com,null}"

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run this deployment script as root." >&2
  exit 1
fi

for command_name in git docker curl; do
  if ! command -v "${command_name}" >/dev/null 2>&1; then
    echo "Missing required command: ${command_name}" >&2
    exit 1
  fi
done

mkdir -p "${APP_DIRECTORY}"
if [[ ! -d "${APP_DIRECTORY}/.git" ]]; then
  git clone --filter=blob:none "${REPOSITORY_URL}" "${APP_DIRECTORY}"
fi

fetch_revision() {
  local attempt
  for attempt in 1 2 3; do
    if git -C "${APP_DIRECTORY}" \
      -c http.version=HTTP/1.1 \
      -c http.lowSpeedLimit=1024 \
      -c http.lowSpeedTime=30 \
      fetch --prune origin \
      "+refs/heads/${APP_REVISION}:refs/remotes/origin/${APP_REVISION}"; then
      return 0
    fi
    if [[ "${attempt}" -lt 3 ]]; then
      sleep "$((attempt * 2))"
    fi
  done
  echo "Failed to fetch ${APP_REVISION} after 3 attempts." >&2
  return 1
}

fetch_revision
git -C "${APP_DIRECTORY}" switch --detach --force "origin/${APP_REVISION}"

GIT_SHA="$(git -C "${APP_DIRECTORY}" rev-parse --short=12 HEAD)"
IMAGE_TAG="${IMAGE_NAME}:${GIT_SHA}"
docker build --pull --tag "${IMAGE_TAG}" "${APP_DIRECTORY}"

docker rm --force "${CONTAINER_NAME}" >/dev/null 2>&1 || true
docker run --detach \
  --name "${CONTAINER_NAME}" \
  --restart unless-stopped \
  --read-only \
  --tmpfs /tmp:size=256m,mode=1777 \
  --cap-drop ALL \
  --security-opt no-new-privileges:true \
  --memory 3g \
  --cpus 3.5 \
  --publish "127.0.0.1:${HOST_PORT}:8787" \
  --env "NODE_ENV=production" \
  --env "REGION=${REGION}" \
  --env "ALLOWED_ORIGINS=${ALLOWED_ORIGINS}" \
  --env "UV_THREADPOOL_SIZE=4" \
  --env "SHARP_CONCURRENCY=2" \
  --env "PROCESS_CONCURRENCY=2" \
  --env "MALLOC_ARENA_MAX=2" \
  "${IMAGE_TAG}" >/dev/null

for attempt in {1..30}; do
  if curl --fail --silent "http://127.0.0.1:${HOST_PORT}/health" >/dev/null; then
    echo "Deployed ${IMAGE_TAG}; health check passed."
    exit 0
  fi
  sleep 1
done

docker logs --tail 100 "${CONTAINER_NAME}" >&2
echo "Deployment failed: health check did not pass." >&2
exit 1
