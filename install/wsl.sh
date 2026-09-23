#!/usr/bin/env bash
# Invoked by windows.ps1 inside an installed WSL distribution.
set -euo pipefail

package_spec=${1:-github:PrometheusTT/moyu#feat/live-on-enter}
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
if [[ -s "$NVM_DIR/nvm.sh" ]]; then
  # shellcheck source=/dev/null
  . "$NVM_DIR/nvm.sh"
fi

if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1 \
  || ! node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 20 ? 0 : 1)' >/dev/null 2>&1; then
  if ! command -v curl >/dev/null 2>&1 || ! command -v git >/dev/null 2>&1; then
    if ! command -v apt-get >/dev/null 2>&1; then
      printf 'Install curl and git in this WSL distribution, then rerun the installer.\n' >&2
      exit 1
    fi
    sudo apt-get update
    sudo apt-get install -y ca-certificates curl git
  fi
  if [[ ! -s "$NVM_DIR/nvm.sh" ]]; then
    installer=$(mktemp)
    trap 'rm -f "$installer"' EXIT
    curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.8/install.sh -o "$installer"
    bash "$installer"
  fi
  # shellcheck source=/dev/null
  . "$NVM_DIR/nvm.sh"
  nvm install --lts
  nvm alias default 'lts/*'
fi

npm install --global "$package_spec"
moyu --help >/dev/null
printf '\nMoyu is ready in WSL. Open the WSL profile in WezTerm and run: moyu play\n'
