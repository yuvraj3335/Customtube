#!/bin/sh
# Download the HackerTube data export (about 18 MB, ODC-By 1.0) into data/raw/.
# Run it yourself once. The export is offered for reuse at https://hackertube.org/data;
# the site's robots.txt asks crawlers to stay off /download/, so don't put this in a loop
# or a CI job. You can also download the zip in a browser and unzip it to the same place.
set -eu

cd "$(dirname "$0")/.."
dest="data/raw"
zip="$dest/hackertube-data.zip"
mkdir -p "$dest"

if [ -f "$dest/hackertube-data/videos.jsonl" ]; then
  echo "Data already in $dest/hackertube-data. Delete that folder to download it again."
  exit 0
fi

echo "Downloading the HackerTube data export..."
curl -fL --proto '=https' --tlsv1.2 -o "$zip" https://hackertube.org/download/hackertube-data.zip

# Refuse archives with absolute paths or ".." before unpacking.
if unzip -Z1 "$zip" | grep -Eq '(^/|(^|/)\.\.(/|$))'; then
  echo "The archive contains unsafe paths; not unpacking it." >&2
  exit 1
fi
unzip -q -o "$zip" -d "$dest"
echo "Done: $dest/hackertube-data"
