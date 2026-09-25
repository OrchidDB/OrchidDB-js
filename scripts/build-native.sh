#!/usr/bin/env bash
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
BUILD_ROOT=${ORCHIDDB_BUILD_ROOT:-"$ROOT/.native-build"}
REVISION=$(tr -d '\r\n' < "$ROOT/NATIVE_REVISION")
[[ "$REVISION" =~ ^[0-9a-f]{40}$ ]] || { echo 'NATIVE_REVISION must be an exact Git SHA' >&2; exit 1; }
mkdir -p "$BUILD_ROOT"
git clone https://github.com/OrchidDB/OrchidDB-native.git "$BUILD_ROOT/orchiddb-native"
git -C "$BUILD_ROOT/orchiddb-native" checkout --detach "$REVISION"
CORE_REVISION=$(tr -d '\r\n' < "$BUILD_ROOT/orchiddb-native/CORE_REVISION")
git clone https://github.com/OrchidDB/OrchidDB.git "$BUILD_ROOT/orchiddb"
git -C "$BUILD_ROOT/orchiddb" checkout --detach "$CORE_REVISION"
ORCHIDDB_RELEASE_BUILD=1 cargo build --locked --release --manifest-path "$BUILD_ROOT/orchiddb-native/Cargo.toml"
node "$ROOT/scripts/stage-native.mjs" "$BUILD_ROOT/orchiddb-native/target/release" "$CORE_REVISION"
