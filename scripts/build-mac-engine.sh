#!/bin/bash
set -euo pipefail
# No build products enter the checkout. This driver is explicit about the
# bootstrap Node; the app itself uses only its checksum-pinned official Node.
script_dir="$(cd -- "$(dirname -- "$0")" && pwd -P)"
build_node="${NIKUI_BUILD_NODE:-/opt/homebrew/bin/node}"
if [[ "$build_node" != /* || ! -x "$build_node" ]]; then
  echo 'Set NIKUI_BUILD_NODE to an absolute executable Node path.' >&2
  exit 1
fi
exec "$build_node" "$script_dir/build-mac-engine.js" "$@"
