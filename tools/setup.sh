#!/usr/bin/env bash
# Vendor the Tailwind standalone binary (gitignored; ~120MB). Run once after clone.
set -e
cd "$(dirname "$0")"
if [ -x tailwindcss ] && ./tailwindcss --help >/dev/null 2>&1; then
  echo "tailwindcss already vendored — skipping."; exit 0
fi
curl -sL -o tailwindcss https://github.com/tailwindlabs/tailwindcss/releases/download/v4.1.5/tailwindcss-linux-x64
chmod +x tailwindcss
./tailwindcss --help >/dev/null 2>&1 || { echo "ERROR: tailwindcss download failed/corrupt"; rm -f tailwindcss; exit 1; }
echo "tailwindcss vendored: $(./tailwindcss --help 2>&1 | head -1)"
