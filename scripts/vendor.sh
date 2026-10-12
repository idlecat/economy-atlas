#!/bin/sh
# Regenerate site/vendor/: d3 and topojson-client as single ES modules, and the Inter font.
# They are served from this site rather than a CDN so the page also works where jsDelivr or
# Google Fonts are blocked or slow (e.g. mainland China). Needs node/npm; run from the repo root.
# Bump the versions here, rerun, and commit site/vendor/.
set -eu
D3=7.9.0 TOPOJSON=3.1.0 INTER=5.1.1 ESBUILD=0.24.2
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
out=site/vendor
mkdir -p "$out/fonts"
(cd "$work" && npm init -y >/dev/null && npm install --silent --no-audit --no-fund \
  "d3@$D3" "topojson-client@$TOPOJSON" "@fontsource/inter@$INTER" "esbuild@$ESBUILD")
echo 'export * from "d3";' > "$work/d3-entry.js"
echo 'export * from "topojson-client";' > "$work/topojson-entry.js"
"$work/node_modules/.bin/esbuild" "$work/d3-entry.js" --bundle --format=esm --minify --legal-comments=eof \
  --banner:js="// d3 $D3 (https://d3js.org, ISC licence), bundled by scripts/vendor.sh" --outfile="$out/d3.js"
"$work/node_modules/.bin/esbuild" "$work/topojson-entry.js" --bundle --format=esm --minify --legal-comments=eof \
  --banner:js="// topojson-client $TOPOJSON (https://github.com/topojson/topojson-client, ISC licence), bundled by scripts/vendor.sh" \
  --outfile="$out/topojson-client.js"
for w in 400 500 600 700; do
  cp "$work/node_modules/@fontsource/inter/files/inter-latin-$w-normal.woff2" "$out/fonts/"
done
cp "$work/node_modules/@fontsource/inter/LICENSE" "$out/fonts/Inter-LICENSE.txt"
echo "vendored d3 $D3, topojson-client $TOPOJSON, Inter $INTER into $out"
