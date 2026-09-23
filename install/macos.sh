#!/bin/sh
# Install Moyu from the GitHub branch on macOS without changing shell profiles.
set -eu

package_spec=${1:-https://codeload.github.com/PrometheusTT/moyu/tar.gz/refs/heads/feat/live-on-enter}

if [ "$(uname -s)" != Darwin ]; then
  printf 'This installer is for macOS. On Windows, use install/windows.ps1.\n' >&2
  exit 2
fi

if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1 \
  || ! node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 20 ? 0 : 1)' >/dev/null 2>&1; then
  if ! command -v brew >/dev/null 2>&1; then
    printf 'Node.js 20+ is required. Install it from https://nodejs.org/ or install Homebrew, then rerun this script.\n' >&2
    exit 1
  fi
  brew install node
fi
if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1 \
  || ! node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 20 ? 0 : 1)' >/dev/null 2>&1; then
  printf 'Node.js 20+ is still unavailable. Open a new terminal or update the Node installation on your PATH.\n' >&2
  exit 1
fi

npm install --global "$package_spec"
moyu --help >/dev/null
printf '\nMoyu is ready. Run: moyu play\n'
printf 'For the full-resolution graphics mode, use Kitty, Ghostty, or WezTerm.\n'
