#!/bin/bash
set -euo pipefail
project_dir="$(cd "$(dirname "$0")/.." && pwd)"
exec node "$project_dir/scripts/build-native-app.mjs"
