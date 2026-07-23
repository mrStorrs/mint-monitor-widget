#!/usr/bin/env bash

set -euo pipefail

uuid="service-monitor@mrStorrs"
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
project_dir="$(cd -- "${script_dir}/.." && pwd)"
source_dir="${project_dir}/${uuid}/files/${uuid}"
destination="${HOME}/.local/share/cinnamon/desklets/${uuid}"

install -d "${destination}"
cp -a "${source_dir}/." "${destination}/"

echo "Installed ${uuid} to ${destination}"
echo "Open System Settings > Desklets to add or reload Service Monitor."
