#!/usr/bin/env bash
# Download only reviewed versions; validate against checked-in SHA256 values.
set -euo pipefail
destination=${1:?usage: install-tools.sh OUTPUT_DIRECTORY}
mkdir -p "$destination"
destination=$(cd "$destination" && pwd)
case "$(uname -s)/$(uname -m)" in
  Linux/x86_64)
    gitleaks_asset=gitleaks_8.30.1_linux_x64.tar.gz
    gitleaks_sha=551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb
    trivy_asset=trivy_0.74.0_Linux-64bit.tar.gz
    trivy_sha=2ae6fe3ee734b7fdf11335663e18c75ea12dccc76062f09f164a3b0f8be4371a
    shellcheck_asset=shellcheck-v0.11.0.linux.x86_64.tar.gz
    shellcheck_sha=b7af85e41cc99489dcc21d66c6d5f3685138f06d34651e6d34b42ec6d54fe6f6 ;;
  Darwin/arm64)
    gitleaks_asset=gitleaks_8.30.1_darwin_arm64.tar.gz
    gitleaks_sha=b40ab0ae55c505963e365f271a8d3846efbc170aa17f2607f13df610a9aeb6a5
    trivy_asset=trivy_0.74.0_macOS-ARM64.tar.gz
    trivy_sha=1caada5e0e2091909357c7525d3aa76f4b660b13821bc143b190c7483e31cc11
    shellcheck_asset=shellcheck-v0.11.0.darwin.aarch64.tar.gz
    shellcheck_sha=339b930feb1ea764467013cc1f72d09cd6b869ebf1013296ba9055ab2ffbd26f ;;
  *) echo 'No reviewed security-tool binaries for this platform.' >&2; exit 2 ;;
esac
scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT
download() {
  local repository=$1 version=$2 asset=$3 expected=$4 binary=$5 member=${6:-$5} actual
  curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 \
    "https://github.com/$repository/releases/download/v$version/$asset" -o "$scratch/$asset"
  actual=$(shasum -a 256 "$scratch/$asset" | cut -d ' ' -f1)
  [[ "$actual" == "$expected" ]] || { echo "Checksum mismatch for $binary" >&2; exit 1; }
  tar -xzf "$scratch/$asset" -C "$scratch" "$member"
  install -m 0755 "$scratch/$member" "$destination/$binary"
}
download gitleaks/gitleaks 8.30.1 "$gitleaks_asset" "$gitleaks_sha" gitleaks
download aquasecurity/trivy 0.74.0 "$trivy_asset" "$trivy_sha" trivy
download koalaman/shellcheck 0.11.0 "$shellcheck_asset" "$shellcheck_sha" shellcheck shellcheck-v0.11.0/shellcheck
