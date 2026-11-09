#!/usr/bin/env bash
# Turn the still-image fixtures into 1-second y4m clips that Chromium can use as
# a fake webcam (--use-file-for-fake-video-capture). Requires ffmpeg.
set -euo pipefail
cd "$(dirname "$0")/../test-fixtures"
for png in *.png; do
  ffmpeg -v error -y -loop 1 -i "$png" -t 1 -r 15 -pix_fmt yuv420p "${png%.png}.y4m"
  echo "wrote ${png%.png}.y4m"
done
