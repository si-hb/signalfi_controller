#!/usr/bin/env bash
# Signalfi multi-arch image publisher.
#
# Builds signalfi-web and signalfi-manifest for linux/amd64 + linux/arm64
# and pushes them to Docker Hub.  Tags with the current git version and
# `latest`.  Consumed by the separate signalfi-airgap project (on a CM4)
# which pulls these images instead of building locally.
#
# Usage:
#   ./publish.sh [web|manifest|both]   (default: both)
#
# Environment:
#   REGISTRY_NAMESPACE   Docker Hub namespace (default: duckminster)
#   VERSION_TAG          override the git-derived version tag
#
# Prerequisites:
#   - docker buildx available (Docker 19.03+)
#   - docker login to the target registry
#   - QEMU binfmt installed for cross-arch builds on a non-arm64 host:
#       docker run --privileged --rm tonistiigi/binfmt --install all

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

NAMESPACE="${REGISTRY_NAMESPACE:-duckminster}"
WEB_IMAGE="$NAMESPACE/signalfi-web"
MANIFEST_IMAGE="$NAMESPACE/signalfi-manifest"
PLATFORMS="linux/amd64,linux/arm64"
BUILDER_NAME="signalfi-multiarch"

log() { printf '==> %s\n' "$*"; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

command -v docker >/dev/null || die "docker is required"
docker buildx version >/dev/null 2>&1 || die "docker buildx is required (Docker 19.03+)"

# Pin a dedicated buildx builder so we don't clobber the user's default.
if ! docker buildx inspect "$BUILDER_NAME" >/dev/null 2>&1; then
    log "Creating buildx builder: $BUILDER_NAME"
    docker buildx create --name "$BUILDER_NAME" --driver docker-container --bootstrap >/dev/null
fi
docker buildx use "$BUILDER_NAME"

# Version tag derived from the commit we're publishing from — dirty suffix
# flags an uncommitted build so downstream never pulls a ghost image.
VERSION="${VERSION_TAG:-$(cd "$SCRIPT_DIR" && git describe --tags --always --dirty 2>/dev/null || date +%Y%m%d-%H%M%S)}"

if [[ "$VERSION" == *-dirty ]]; then
    log "WARN: working tree is dirty — VERSION=$VERSION"
    read -r -p "Publish anyway? [y/N] " confirm
    [[ "$confirm" =~ ^[Yy]$ ]] || die "Cancelled."
fi

publish_image() {
    local dockerfile_dir="$1" image="$2"
    log "Building $image:$VERSION for $PLATFORMS"
    docker buildx build \
        --platform "$PLATFORMS" \
        --tag "$image:$VERSION" \
        --tag "$image:latest" \
        --push \
        "$dockerfile_dir"
    log "Pushed $image:$VERSION and $image:latest"
}

TARGET="${1:-both}"
case "$TARGET" in
    web)
        publish_image "$SCRIPT_DIR" "$WEB_IMAGE"
        ;;
    manifest)
        publish_image "$SCRIPT_DIR/https_file_server/manifest-service" "$MANIFEST_IMAGE"
        ;;
    both)
        publish_image "$SCRIPT_DIR" "$WEB_IMAGE"
        publish_image "$SCRIPT_DIR/https_file_server/manifest-service" "$MANIFEST_IMAGE"
        ;;
    *)
        die "Unknown target: $TARGET.  Use: web | manifest | both"
        ;;
esac

log "Published version: $VERSION"
echo ""
echo "Pull from any arch with:"
echo "  docker pull $WEB_IMAGE:$VERSION"
echo "  docker pull $MANIFEST_IMAGE:$VERSION"
