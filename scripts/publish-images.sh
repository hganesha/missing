#!/usr/bin/env bash
set -euo pipefail

: "${IMAGE_REGISTRY:?Set IMAGE_REGISTRY, for example ghcr.io/acme/ehf}"
revision="${IMAGE_REVISION:-$(git rev-parse HEAD)}"

publish() {
  local service="$1"
  local dockerfile="$2"
  local image="${IMAGE_REGISTRY}/${service}:${revision}"
  shift 2
  docker buildx build \
    --file "$dockerfile" \
    --platform "${IMAGE_PLATFORMS:-linux/amd64,linux/arm64}" \
    --label "org.opencontainers.image.revision=${revision}" \
    --provenance=mode=max \
    --sbom=true \
    --push \
    --tag "$image" \
    "$@" "${PUBLISH_CONTEXT:-.}"
  docker buildx imagetools inspect "$image" --format '{{.Name}}@{{.Manifest.Digest}}'
}

# The single application image; SERVICE_NAME selects the service when it runs.
publish integralflow Dockerfile.platform --build-arg "IMAGE_REVISION=${revision}"
# Python services, each built from its own directory and Dockerfile.
for service in fincrime-host evidence-pipeline kyc-wiring; do
  PUBLISH_CONTEXT="apps/${service}" publish "$service" "apps/${service}/Dockerfile"
done
