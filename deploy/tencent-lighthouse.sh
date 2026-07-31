#!/usr/bin/env bash
set -Eeuo pipefail

# Reproducible Tencent Cloud Lighthouse deployment with candidate validation
# and automatic rollback to the previously running image.
REPOSITORY_URL="${REPOSITORY_URL:-https://github.com/xcq403658606-ai/figma-cmyk-api.git}"
APP_REVISION="${APP_REVISION:-main}"
APP_DIRECTORY="${APP_DIRECTORY:-/opt/edc-box-api}"
IMAGE_NAME="${IMAGE_NAME:-edc-box-api}"
CONTAINER_NAME="${CONTAINER_NAME:-edc-box-api-next}"
CANDIDATE_NAME="${CANDIDATE_NAME:-${CONTAINER_NAME}-candidate}"
HOST_PORT="${HOST_PORT:-8787}"
CANDIDATE_PORT="${CANDIDATE_PORT:-18787}"
REGION="${REGION:-ap-shanghai}"
ALLOWED_ORIGINS="${ALLOWED_ORIGINS:-https://www.figma.com,null}"
CMYK_ICC_NAME="${CMYK_ICC_NAME:-CoatedFOGRA39}"
CMYK_ICC_SHA256="${CMYK_ICC_SHA256:-da2b9b593e27cba2563cbc8596071c5c8f2395d3dbb4434538bac2bc9d58ce77}"
MAX_CONCURRENT_REQUESTS="${MAX_CONCURRENT_REQUESTS:-2}"
PROCESS_CONCURRENCY="${PROCESS_CONCURRENCY:-1}"
SHARP_CONCURRENCY="${SHARP_CONCURRENCY:-2}"

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run this deployment script as root." >&2
  exit 1
fi

if [[ -z "${API_BEARER_TOKEN:-}" ]]; then
  echo "API_BEARER_TOKEN must be provided through the deployment environment." >&2
  exit 1
fi

for command_name in git docker curl; do
  if ! command -v "${command_name}" >/dev/null 2>&1; then
    echo "Missing required command: ${command_name}" >&2
    exit 1
  fi
done

if [[ "${HOST_PORT}" == "${CANDIDATE_PORT}" ]]; then
  echo "HOST_PORT and CANDIDATE_PORT must be different." >&2
  exit 1
fi

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

wait_for_health() {
  local port="$1"
  local container="$2"
  local attempt
  for attempt in {1..30}; do
    if curl --fail --silent --max-time 2 "http://127.0.0.1:${port}/health" >/dev/null; then
      return 0
    fi
    sleep 1
  done
  docker logs --tail 100 "${container}" >&2 || true
  return 1
}

run_container() {
  local name="$1"
  local port="$2"
  local image="$3"
  docker run --detach \
    --name "${name}" \
    --restart unless-stopped \
    --read-only \
    --tmpfs /tmp:size=256m,mode=1777 \
    --cap-drop ALL \
    --security-opt no-new-privileges:true \
    --memory 3g \
    --cpus 3.5 \
    --log-driver local \
    --log-opt max-size=10m \
    --log-opt max-file=3 \
    --publish "127.0.0.1:${port}:8787" \
    --env "NODE_ENV=production" \
    --env "REGION=${REGION}" \
    --env "ALLOWED_ORIGINS=${ALLOWED_ORIGINS}" \
    --env "API_BEARER_TOKEN" \
    --env "CMYK_ICC_NAME=${CMYK_ICC_NAME}" \
    --env "CMYK_ICC_SHA256=${CMYK_ICC_SHA256}" \
    --env "UV_THREADPOOL_SIZE=4" \
    --env "SHARP_CONCURRENCY=${SHARP_CONCURRENCY}" \
    --env "PROCESS_CONCURRENCY=${PROCESS_CONCURRENCY}" \
    --env "MAX_CONCURRENT_REQUESTS=${MAX_CONCURRENT_REQUESTS}" \
    --env "MALLOC_ARENA_MAX=2" \
    "${image}" >/dev/null
}

cleanup_candidate() {
  docker rm --force "${CANDIDATE_NAME}" >/dev/null 2>&1 || true
}
trap cleanup_candidate EXIT

fetch_revision
git -C "${APP_DIRECTORY}" switch --detach --force "origin/${APP_REVISION}"

GIT_SHA="$(git -C "${APP_DIRECTORY}" rev-parse --short=12 HEAD)"
IMAGE_TAG="${IMAGE_NAME}:${GIT_SHA}"
docker build --pull --tag "${IMAGE_TAG}" "${APP_DIRECTORY}"

PREVIOUS_IMAGE=""
if docker container inspect "${CONTAINER_NAME}" >/dev/null 2>&1; then
  PREVIOUS_IMAGE="$(docker inspect --format '{{.Config.Image}}' "${CONTAINER_NAME}")"
fi

rollback_previous() {
  docker rm --force "${CONTAINER_NAME}" >/dev/null 2>&1 || true
  if [[ -z "${PREVIOUS_IMAGE}" ]]; then
    echo "No previous image was available for rollback." >&2
    return 1
  fi
  echo "Rolling back to the previous image." >&2
  if run_container "${CONTAINER_NAME}" "${HOST_PORT}" "${PREVIOUS_IMAGE}" &&
    wait_for_health "${HOST_PORT}" "${CONTAINER_NAME}"; then
    echo "Rollback to ${PREVIOUS_IMAGE} completed." >&2
    return 0
  fi
  echo "Rollback failed health verification; manual intervention is required." >&2
  return 1
}

cleanup_candidate
if ! run_container "${CANDIDATE_NAME}" "${CANDIDATE_PORT}" "${IMAGE_TAG}"; then
  echo "Deployment failed: candidate container could not start; active service was untouched." >&2
  exit 1
fi
if ! wait_for_health "${CANDIDATE_PORT}" "${CANDIDATE_NAME}"; then
  echo "Deployment failed: candidate health check did not pass; active service was untouched." >&2
  exit 1
fi
cleanup_candidate

docker rm --force "${CONTAINER_NAME}" >/dev/null 2>&1 || true
if ! run_container "${CONTAINER_NAME}" "${HOST_PORT}" "${IMAGE_TAG}"; then
  echo "New active container could not start." >&2
  rollback_previous || true
  exit 1
fi
if wait_for_health "${HOST_PORT}" "${CONTAINER_NAME}"; then
  echo "Deployed ${IMAGE_TAG}; candidate and active health checks passed."
  exit 0
fi

echo "New active container failed its health check." >&2
rollback_previous || true
exit 1
