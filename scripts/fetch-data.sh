#!/bin/sh
# Download the video data export (about 18 MB, ODC-By 1.0) into data/raw/export.
# Run it yourself once (the Docker build runs it too); don't put it in a loop or a CI job.
set -eu

cd "$(dirname "$0")/.."
dest="data/raw"
out="$dest/export"
zip="$dest/export.zip"
mkdir -p "$dest"

if [ -f "$out/videos.jsonl" ]; then
  echo "Data already in $out. Delete that folder to download it again."
  exit 0
fi

echo "Downloading the data export..."
curl -fL --proto '=https' --tlsv1.2 -o "$zip" https://hackertube.org/download/hackertube-data.zip

# Refuse archives with absolute paths or ".." before unpacking.
if unzip -Z1 "$zip" | grep -Eq '(^/|(^|/)\.\.(/|$))'; then
  echo "The archive contains unsafe paths; not unpacking it." >&2
  exit 1
fi
tmp="$dest/.unpack"
rm -rf "$tmp"
unzip -q -o "$zip" -d "$tmp"
# the archive holds a single top-level folder; move its contents to $out
top=$(find "$tmp" -mindepth 1 -maxdepth 1 -type d | head -1)
rm -rf "$out"
mv "$top" "$out"
rm -rf "$tmp" "$zip"
echo "Done: $out"
