#!/usr/bin/env bash
set -euo pipefail

RAPFI_COMMIT="1be1551ced57e38d53ed58f6d74bf6f8b4bdc230"
NETWORKS_COMMIT="918b757a129258e9e765f77fe17d507c2bb1a60b"
ROOT="${1:-.cache}"
SRC="$ROOT/rapfi-src"
ENGINE="$ROOT/engine"

if [[ -x "$ENGINE/rapfi" && -f "$ENGINE/config.toml" ]]; then
  echo "[auto-book] cached Rapfi engine found"
  exit 0
fi

rm -rf "$SRC" "$ENGINE"
mkdir -p "$ROOT"

git clone --quiet https://github.com/dhbloo/rapfi.git "$SRC"
git -C "$SRC" checkout --quiet "$RAPFI_COMMIT"
git -C "$SRC" submodule update --init --depth 1 Networks

actual_networks="$(git -C "$SRC/Networks" rev-parse HEAD)"
if [[ "$actual_networks" != "$NETWORKS_COMMIT" ]]; then
  echo "unexpected rapfi-networks commit: $actual_networks" >&2
  exit 1
fi

cmake -S "$SRC/Rapfi" -B "$SRC/Rapfi/build" \
  -DCMAKE_BUILD_TYPE=Release \
  -DUSE_SSE=ON \
  -DUSE_AVX2=ON \
  -DUSE_AVX512=OFF \
  -DUSE_BMI2=OFF \
  -DUSE_VNNI=OFF
cmake --build "$SRC/Rapfi/build" -j2

mkdir -p "$ENGINE"
cp "$SRC/Rapfi/build/pbrain-rapfi" "$ENGINE/rapfi"
chmod +x "$ENGINE/rapfi"
find "$SRC/Networks" -mindepth 2 -type f -exec cp {} "$ENGINE/" \;

for required in \
  config.toml \
  model210901.bin \
  mix9svqfreestyle_bsmix.bin.lz4 \
  mix9svqstandard_bs15.bin.lz4 \
  mix9svqrenju_bs15_black.bin.lz4 \
  mix9svqrenju_bs15_white.bin.lz4; do
  if [[ ! -f "$ENGINE/$required" ]]; then
    echo "missing Rapfi runtime file: $required" >&2
    exit 1
  fi
done

if ! grep -q 'coord_conversion_mode = "none"' "$ENGINE/config.toml"; then
  echo "Rapfi config must use coord_conversion_mode=none" >&2
  exit 1
fi

cat > "$ENGINE/jukan-engine.json" <<EOF
{"rapfiCommit":"$RAPFI_COMMIT","networksCommit":"$NETWORKS_COMMIT","build":"native-linux-avx2"}
EOF

echo "[auto-book] Rapfi $RAPFI_COMMIT / networks $NETWORKS_COMMIT ready"
