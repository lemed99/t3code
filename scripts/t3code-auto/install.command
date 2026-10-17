#!/usr/bin/env bash
# Installs or updates T3 Code with automatic Claude account switching, built
# from the patched branch of a T3 Code fork. Double-click it the first time;
# after that the app's Settings → Patch updates runs it, and so does a weekly
# check. It never quits T3 Code: a finished build installs once T3 Code is
# closed (or restarted from Settings).
#
#   install.command                 interactive install or update
#   install.command --unattended    no prompts; skips the build when up to date
#   install.command --relaunch      reopen T3 Code after installing
#   install.command --force         rebuild even when up to date
#
# One-time requirements: Xcode Command Line Tools, Rust (rustup.rs), Node 24.
set -euo pipefail

FORK_OWNER="lemed99"
FORK="https://github.com/$FORK_OWNER/t3code"
BRANCH="auto-account-switch"

BASE="$HOME/t3code-auto"
REPO="$BASE/src"
TOOLS="$BASE/tools"
LOG="$BASE/update.log"
STATUS="$BASE/status.json"
INSTALLED="$BASE/installed-version"
AGENTS="$HOME/Library/LaunchAgents"
UNATTENDED=0
RELAUNCH=0
FORCE=0
for arg in "$@"; do
  case "$arg" in
    --unattended) UNATTENDED=1 ;;
    --relaunch) RELAUNCH=1 ;;
    --force) FORCE=1 ;;
  esac
done

mkdir -p "$BASE" "$TOOLS"
# Run from a download, it keeps a copy for Settings and the weekly check.
HERE="$(cd "$(dirname "$0")" && pwd)"
if [[ "$HERE" != "$TOOLS" ]]; then
  cp "$0" "$TOOLS/install.command"
  chmod +x "$TOOLS/install.command"
fi

# What Settings → Patch updates shows while this runs.
VERSION=""
status() {
  local phase="$1" message="${2:-}"
  node -e '
    const [file, phase, message, version, pid] = process.argv.slice(1);
    const tmp = file + ".tmp";
    require("fs").writeFileSync(tmp, JSON.stringify({
      phase, message, version: version || null, pid: Number(pid), at: Date.now(),
    }));
    require("fs").renameSync(tmp, file);
  ' "$STATUS" "$phase" "$message" "$VERSION" "$$" 2>/dev/null || true
}
notify() {
  osascript -e "display notification \"$1\" with title \"T3 Code updater\"" >/dev/null 2>&1 || true
}
fail() {
  echo "ERROR: $1" >&2
  status failed "$1"
  notify "$1"
  [[ "$UNATTENDED" == "1" ]] || read -r -p "Press Return to close." _
  exit 1
}
trap 'status failed "The update stopped unexpectedly. Details are in ~/t3code-auto/update.log."' ERR

# One run at a time: a second one (say the weekly check during a manual
# update) leaves the first to finish.
LOCK="$BASE/update.lock"
if ! mkdir "$LOCK" 2>/dev/null; then
  if [[ -f "$LOCK/pid" ]] && kill -0 "$(cat "$LOCK/pid")" 2>/dev/null; then
    echo "An update is already running."
    exit 0
  fi
  rm -rf "$LOCK" && mkdir "$LOCK"
fi
echo $$ >"$LOCK/pid"
trap 'rm -rf "$LOCK"' EXIT

status checking "Checking for a new version"
for tool in git node cargo; do
  command -v "$tool" >/dev/null || fail "Missing $tool. Install Xcode Command Line Tools, Rust and Node 24 first."
done
[[ "$(node -p 'process.versions.node.split(".")[0]')" -ge 24 ]] || fail "T3 Code needs Node 24 or newer."

echo "==> Getting the latest patched T3 Code"
if [[ ! -d "$REPO/.git" ]]; then
  git clone --single-branch --branch "$BRANCH" "$FORK" "$REPO" || fail "Could not download T3 Code. Check your connection."
fi
cd "$REPO"
git am --abort >/dev/null 2>&1 || true
git remote get-url auto >/dev/null 2>&1 || git remote add auto "$FORK"
git remote set-url auto "$FORK"
git fetch auto "$BRANCH" || fail "Could not reach $FORK. Check your connection."
VERSION="$(git rev-parse "auto/$BRANCH")"
if [[ "$FORCE" == "0" && -f "$INSTALLED" && "$(cat "$INSTALLED")" == "$VERSION" ]] &&
  compgen -G "/Applications/T3 Code*.app" >/dev/null; then
  echo "==> Already up to date."
  status up-to-date "T3 Code is up to date"
  [[ "$UNATTENDED" == "1" ]] || read -r -p "Press Return to close." _
  exit 0
fi
git checkout -q -f -B "$BRANCH" "auto/$BRANCH"

echo "==> Installing dependencies"
status downloading "Downloading what the build needs"
# The repo also fetches Linux and Intel builds of its tools (hundreds of MB).
# This Mac only needs its own, which keeps the download small.
node -e '
const fs = require("fs");
const p = "pnpm-workspace.yaml";
fs.writeFileSync(p, fs.readFileSync(p, "utf8").replace(
  /supportedArchitectures:\n(  .*\n)+/,
  "supportedArchitectures:\n  cpu: [current]\n  libc: [current]\n  os: [current]\n"));
'
# Slow connections time out on big downloads. Each attempt keeps what it
# already fetched, so retrying with fewer parallel downloads finishes the job.
installed=""
for attempt in 1 2 3 4 5; do
  if corepack pnpm install --frozen-lockfile --network-concurrency 2 \
      --fetch-timeout 600000 --fetch-retries 5; then
    installed=1; break
  fi
  echo "    Download interrupted (attempt $attempt of 5). Resuming in 30 seconds..."
  sleep 30
done
[[ -n "$installed" ]] || fail "Downloads keep timing out. Check your connection and try again; it resumes where it stopped."
git checkout -q -- pnpm-workspace.yaml

echo "==> Updating Rust"
# T3 Code's native helper tracks recent Rust releases; keep the toolchain current.
if command -v rustup >/dev/null; then
  rustup update stable --no-self-update || fail "Could not update Rust. Check your connection and try again."
  rustup default stable >/dev/null
elif command -v brew >/dev/null && brew list rust >/dev/null 2>&1; then
  brew upgrade rust || true
else
  echo "    Rust was not installed with rustup or Homebrew; using it as is."
fi

echo "==> Building the app (takes a few minutes)"
status building "Building the new version (takes a few minutes)"
rm -rf release
if [[ "$(uname -m)" == "arm64" ]]; then ARCH=arm64; else ARCH=x64; fi
corepack pnpm exec vp run "dist:desktop:dmg:$ARCH"
DMG="$(ls -t release/*.dmg | head -1)" || fail "The build did not produce an app."

echo "==> Staging the new build"
STAGE="$BASE/staged"
rm -rf "$STAGE" && mkdir -p "$STAGE"
MOUNT="$(mktemp -d)"
hdiutil attach -nobrowse -quiet -mountpoint "$MOUNT" "$DMG"
APP="$(find "$MOUNT" -maxdepth 1 -name '*.app' | head -1)"
NAME="$(basename "$APP" .app)"
ditto "$APP" "$STAGE/$NAME.app"
hdiutil detach -quiet "$MOUNT"

# Next runs use the installer from this version.
cp "$REPO/scripts/t3code-auto/install.command" "$TOOLS/install.command.next"
chmod +x "$TOOLS/install.command.next"

# Never quit T3 Code: an agent may be working. Wait until it is closed.
is_running() {
  [[ "$(osascript -e "application \"$NAME\" is running" 2>/dev/null)" == "true" ]]
}
if is_running; then
  echo "==> The update is ready. Quit $NAME to install it (it will install as soon as you do)."
  status ready "Ready. It installs when you restart T3 Code."
  notify "An update is ready. It installs the next time you quit $NAME."
  WAITED=0
  while is_running; do
    sleep 10
    WAITED=$((WAITED + 10))
    # Give up after 6 days; the weekly check builds a fresh update.
    [[ "$WAITED" -lt 518400 ]] || fail "$NAME stayed open all week; the update will try again next week."
  done
  sleep 3
fi

echo "==> Installing into /Applications"
status installing "Installing"
is_running && fail "$NAME was reopened before the update could install; it will try again next week."
rm -rf "/Applications/$NAME.app"
ditto "$STAGE/$NAME.app" "/Applications/$NAME.app"
rm -rf "$STAGE"
xattr -dr com.apple.quarantine "/Applications/$NAME.app" 2>/dev/null || true
echo "$VERSION" >"$INSTALLED"

echo "==> Keeping T3 Code's own updater off, and scheduling weekly checks"
mkdir -p "$AGENTS"
cat >"$AGENTS/dev.t3code-auto.env.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>dev.t3code-auto.env</string>
  <key>ProgramArguments</key><array>
    <string>/bin/launchctl</string><string>setenv</string>
    <string>T3CODE_DISABLE_AUTO_UPDATE</string><string>true</string>
  </array>
  <key>RunAtLoad</key><true/>
</dict></plist>
PLIST
cat >"$AGENTS/dev.t3code-auto.update.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>dev.t3code-auto.update</string>
  <key>ProgramArguments</key><array>
    <string>/bin/bash</string><string>$TOOLS/install.command</string><string>--unattended</string>
  </array>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>$PATH</string>
  </dict>
  <key>StartCalendarInterval</key><dict>
    <key>Weekday</key><integer>1</integer>
    <key>Hour</key><integer>4</integer>
    <key>Minute</key><integer>0</integer>
  </dict>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
</dict></plist>
PLIST
for agent in env update; do
  launchctl bootout "gui/$(id -u)" "$AGENTS/dev.t3code-auto.$agent.plist" >/dev/null 2>&1 || true
  launchctl bootstrap "gui/$(id -u)" "$AGENTS/dev.t3code-auto.$agent.plist"
done
launchctl setenv T3CODE_DISABLE_AUTO_UPDATE true
# Replaced last: this script may be running from that file.
mv -f "$TOOLS/install.command.next" "$TOOLS/install.command"

status installed "T3 Code is up to date"
notify "$NAME is updated."
echo "==> Done. $NAME is in /Applications."
if [[ "$RELAUNCH" == "1" || "$UNATTENDED" == "0" ]]; then
  open "/Applications/$NAME.app"
fi
[[ "$UNATTENDED" == "1" ]] || read -r -p "Press Return to close." _
