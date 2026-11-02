#!/usr/bin/env bash
# Empaqueta la extension en dist/ con el manifest en la raiz del zip.
set -euo pipefail

cd "$(dirname "$0")/.."
VERSION=$(python3 -c "import json;print(json.load(open('manifest.json'))['version'])")
OUT="dist/temu-cart-insight-${VERSION}.zip"

mkdir -p dist
rm -f "$OUT"
zip -r -q "$OUT" manifest.json src icons -x "*.DS_Store"
echo "$OUT ($(du -h "$OUT" | cut -f1))"
python3 - "$OUT" <<'PY'
import sys, zipfile
z = zipfile.ZipFile(sys.argv[1])
names = z.namelist()
assert "manifest.json" in names, "manifest.json debe estar en la raiz"
print("archivos:", len(names))
PY
