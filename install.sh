#!/usr/bin/env bash

set -euo pipefail

REPOSITORY_URL="https://github.com/Dev-Jahn/claude-code-cache-fix"
RAW_INSTALLER_URL="https://raw.githubusercontent.com/Dev-Jahn/claude-code-cache-fix"
BRANCH="soul-jar"
PORT="9801"
DRY_RUN=0
UNINSTALL=0
INSTALL_DIR=""
PLATFORM=""
SYSTEMCTL_ENV=""
BACKUP_PATH=""
STATE_PATH=""
HAD_STATE=0

usage() {
  cat <<'EOF'
Usage: install.sh [options]

Install the claude-code-cache-fix companion for soul-jar.

Options:
  --uninstall       Remove companion-owned wiring and uninstall the service
  --dry-run         Print every mutating action without performing it
  --branch <name>   Git branch to install (default: soul-jar)
  --dir <checkout>  Installer-owned checkout directory
  --port <N>        Proxy port (default: 9801)
  -h, --help        Show this help
EOF
}

die() {
  printf 'soul-jar companion: %s\n' "$*" >&2
  exit 1
}

print_command() {
  local argument
  printf 'DRY-RUN:'
  for argument in "$@"; do
    printf ' %q' "$argument"
  done
  printf '\n'
}

run_mutation() {
  if ((DRY_RUN)); then
    print_command "$@"
  else
    "$@"
  fi
}

parse_args() {
  while (($#)); do
    case "$1" in
      --uninstall)
        UNINSTALL=1
        shift
        ;;
      --dry-run)
        DRY_RUN=1
        shift
        ;;
      --branch)
        (($# >= 2)) || die "--branch requires a value"
        BRANCH=$2
        shift 2
        ;;
      --dir)
        (($# >= 2)) || die "--dir requires a value"
        INSTALL_DIR=$2
        shift 2
        ;;
      --port)
        (($# >= 2)) || die "--port requires a value"
        PORT=$2
        shift 2
        ;;
      -h | --help)
        usage
        exit 0
        ;;
      *)
        die "unknown option: $1"
        ;;
    esac
  done

  [[ $PORT =~ ^[0-9]+$ ]] || die "--port must be an integer in 1..65535"
  ((10#$PORT >= 1 && 10#$PORT <= 65535)) || die "--port must be in 1..65535"
  [[ -n $BRANCH ]] || die "--branch cannot be empty"
  : "${HOME:?HOME must be set}"
  if [[ -z $INSTALL_DIR ]]; then
    INSTALL_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/claude-code-cache-fix"
  fi
  [[ $INSTALL_DIR != *[[:space:]]* ]] || \
    die "install directory contains whitespace; choose a space-free --dir path"
}

set_paths() {
  CLAUDE_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
  SOUL_JAR_DIR="${SOUL_JAR_HOME:-$HOME/.soul-jar}"
  SETTINGS_PATH="$CLAUDE_DIR/settings.json"
  SOUL_CONFIG_PATH="$SOUL_JAR_DIR/config"
  CA_PEM="$CLAUDE_DIR/cache-fix-ca/ca.pem"
  PROXY_URL="http://127.0.0.1:$PORT"
  STATE_PATH="$INSTALL_DIR/.companion-state.json"
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "required command not found: $1"
}

detect_platform() {
  case "$(uname -s)" in
    Linux) PLATFORM="linux" ;;
    Darwin) PLATFORM="darwin" ;;
    *) die "unsupported platform: $(uname -s) (Linux and macOS are supported)" ;;
  esac
}

systemctl_user() {
  if [[ -n $SYSTEMCTL_ENV ]]; then
    XDG_RUNTIME_DIR=$SYSTEMCTL_ENV systemctl --user "$@"
  else
    systemctl --user "$@"
  fi
}

systemd_preflight() {
  local runtime_dir attempt
  systemctl --user show-environment >/dev/null 2>&1 && return

  runtime_dir="/run/user/$(id -u)"
  if [[ -d $runtime_dir ]]; then
    export XDG_RUNTIME_DIR=$runtime_dir
    SYSTEMCTL_ENV=$runtime_dir
    systemctl --user show-environment >/dev/null 2>&1 && return
  fi

  if ((DRY_RUN)); then
    print_command loginctl enable-linger "${USER:-$(id -un)}"
    printf 'DRY-RUN: wait for %q and retry systemctl --user\n' "$runtime_dir"
    return
  fi

  if command -v loginctl >/dev/null 2>&1; then
    printf 'User systemd manager is unavailable; attempting loginctl enable-linger %s\n' \
      "${USER:-$(id -un)}"
    loginctl enable-linger "${USER:-$(id -un)}" >/dev/null 2>&1 || true
    for attempt in 1 2 3 4 5; do
      if [[ -d $runtime_dir ]]; then
        export XDG_RUNTIME_DIR=$runtime_dir
        SYSTEMCTL_ENV=$runtime_dir
        systemctl --user show-environment >/dev/null 2>&1 && return
      fi
      sleep 1
    done
  fi

  cat >&2 <<EOF
soul-jar companion: no working systemd user manager was found.
The repository's manual-unit alternative is to run this under a user supervisor:
  CACHE_FIX_FORWARD_PROXY=on CACHE_FIX_PROXY_PORT=$PORT node "$INSTALL_DIR/proxy/server.mjs"
One workable user-crontab health restart is:
  * * * * * curl -fs http://127.0.0.1:$PORT/health >/dev/null || nohup env CACHE_FIX_FORWARD_PROXY=on CACHE_FIX_PROXY_PORT=$PORT node "$INSTALL_DIR/proxy/server.mjs" >>"$HOME/cache-fix-proxy.log" 2>&1 &
Fix the user manager or supervise that command, then re-run this installer.
EOF
  exit 1
}

service_preflight() {
  [[ ${SOUL_JAR_COMPANION_SKIP_SERVICE:-0} == 1 ]] && return
  if [[ $PLATFORM == linux ]]; then
    require_command systemctl
    systemd_preflight
  else
    require_command launchctl
  fi
}

basic_preflight() {
  require_command git
  require_command curl
  require_command node
  require_command npm
  local node_major
  node_major=$(node -p 'Number(process.versions.node.split(".")[0])') || die "could not read Node.js version"
  ((node_major >= 18)) || die "Node.js 18 or newer is required (found major version $node_major)"
  detect_platform
}

preflight() {
  basic_preflight
  service_preflight
}

transform_settings() {
  local mode=$1 action=$2
  # The embedded JavaScript uses template literals; the shell must not expand them.
  # shellcheck disable=SC2016
  node -e '
const fs = require("fs");
const [path, statePath, mode, action, proxyUrl, caPem] = process.argv.slice(1);
let root = {};
let source = "";
if (fs.existsSync(path)) {
  try { source = fs.readFileSync(path, "utf8"); root = JSON.parse(source); }
  catch (error) { console.error(`Invalid JSON in ${path}: ${error.message}`); process.exit(1); }
}
if (!root || typeof root !== "object" || Array.isArray(root)) {
  console.error(`${path} must contain a JSON object`); process.exit(1);
}
if (root.env !== undefined && (!root.env || typeof root.env !== "object" || Array.isArray(root.env))) {
  console.error(`${path}: .env must be a JSON object`); process.exit(1);
}
const env = root.env || {};
const own = (key) => Object.prototype.hasOwnProperty.call(env, key);
const locals = ["localhost", "127.0.0.1", "::1"];
const entries = (value) => String(value || "").split(",").map((part) => part.trim()).filter(Boolean);
const merge = (value) => {
  const result = entries(value);
  for (const entry of locals) if (!result.includes(entry)) result.push(entry);
  return result.join(",");
};
const strip = (value) => String(value || "").split(",").map((part) => part.trim())
  .filter((entry) => entry && !locals.includes(entry)).join(",");
const original = JSON.stringify(root);
const desired = structuredClone(root);
desired.env ||= {};
if (mode === "install") {
  if (own("ANTHROPIC_BASE_URL")) {
    console.error(`${path}: .env.ANTHROPIC_BASE_URL already exists; reverse and forward proxy wiring cannot be stacked`);
    process.exit(2);
  }
  for (const key of ["HTTPS_PROXY", "https_proxy"]) {
    if (own(key) && env[key] !== proxyUrl) {
      console.error(`${path}: .env.${key} already points at ${JSON.stringify(env[key])}; refusing to replace an existing proxy`);
      process.exit(2);
    }
  }
  if (own("NODE_EXTRA_CA_CERTS") && env.NODE_EXTRA_CA_CERTS !== caPem) {
    console.error(`${path}: .env.NODE_EXTRA_CA_CERTS already points at ${JSON.stringify(env.NODE_EXTRA_CA_CERTS)}; publish component CAs under the repo\x27s ca-trust.d contract and use its merged bundle instead of replacing the existing CA path`);
    process.exit(2);
  }
  desired.env.HTTPS_PROXY = proxyUrl;
  desired.env.https_proxy = proxyUrl;
  desired.env.NODE_EXTRA_CA_CERTS = caPem;
  desired.env.NO_PROXY = merge(env.NO_PROXY);
  desired.env.no_proxy = merge(env.no_proxy);
} else if (fs.existsSync(statePath)) {
  let state;
  try { state = JSON.parse(fs.readFileSync(statePath, "utf8")); }
  catch (error) { console.error(`Invalid companion state in ${statePath}: ${error.message}`); process.exit(1); }
  const settings = state.settings;
  for (const [key, installed] of [
    ["HTTPS_PROXY", proxyUrl], ["https_proxy", proxyUrl], ["NODE_EXTRA_CA_CERTS", caPem],
  ]) {
    const prior = settings.env[key];
    if (desired.env[key] !== installed) continue;
    if (prior.preExisting) desired.env[key] = prior.value;
    else delete desired.env[key];
  }
  for (const key of ["NO_PROXY", "no_proxy"]) {
    if (!own(key)) continue;
    const prior = settings.noProxy[key];
    const added = new Set(prior.added);
    const value = entries(env[key]).filter((entry) => !added.has(entry)).join(",");
    if (value || prior.preExisting) desired.env[key] = value;
    else delete desired.env[key];
  }
  if (Object.keys(desired.env).length === 0 && !settings.envExisted) delete desired.env;
  if (!settings.existed && JSON.stringify(desired) === "{}") {
    if (action === "status") process.stdout.write(fs.existsSync(path) ? "change" : "same");
    else fs.rmSync(path, { force: true });
    process.exit(0);
  }
} else {
  for (const key of ["HTTPS_PROXY", "https_proxy"]) {
    if (desired.env[key] === proxyUrl) delete desired.env[key];
  }
  if (desired.env.NODE_EXTRA_CA_CERTS === caPem) delete desired.env.NODE_EXTRA_CA_CERTS;
  for (const key of ["NO_PROXY", "no_proxy"]) {
    if (!own(key)) continue;
    const value = strip(env[key]);
    if (value) desired.env[key] = value;
    else delete desired.env[key];
  }
  if (Object.keys(desired.env).length === 0) delete desired.env;
}
if (action === "status") {
  process.stdout.write(original === JSON.stringify(desired) ? "same" : "change");
} else {
  const body = source.replace(/\r?\n$/, "");
  const indentMatch = body.match(/\r?\n([ \t]+)"/);
  const indent = body.includes("\n") ? (indentMatch ? indentMatch[1] : 2) : (source ? 0 : 2);
  const eol = source.includes("\r\n") ? "\r\n" : "\n";
  const trailing = !source || source.endsWith("\n");
  let output = JSON.stringify(desired, null, indent).replace(/\n/g, eol);
  if (trailing) output += eol;
  fs.writeFileSync(path, output);
}
' "$SETTINGS_PATH" "$STATE_PATH" "$mode" "$action" "$PROXY_URL" "$CA_PEM"
}

settings_status() {
  transform_settings "$1" status
}

write_settings() {
  transform_settings "$1" write
}

next_backup_path() {
  local epoch candidate
  epoch=$(date +%s)
  candidate="$SETTINGS_PATH.bak.soul-jar-companion.$epoch"
  while [[ -e $candidate ]]; do
    ((epoch += 1))
    candidate="$SETTINGS_PATH.bak.soul-jar-companion.$epoch"
  done
  printf '%s' "$candidate"
}

backup_settings() {
  [[ -f $SETTINGS_PATH ]] || return 0
  local backup
  backup=$(next_backup_path)
  run_mutation cp -p "$SETTINGS_PATH" "$backup"
  BACKUP_PATH=$backup
}

apply_settings() {
  local mode=$1 state
  state=$(settings_status "$mode")
  [[ $state == change ]] || return 0
  if [[ $mode == install ]]; then
    backup_settings
  fi
  run_mutation mkdir -p "$CLAUDE_DIR"
  if ((DRY_RUN)); then
    printf 'DRY-RUN: update %q for companion %s wiring\n' "$SETTINGS_PATH" "$mode"
  else
    write_settings "$mode"
  fi
}

validate_companion_state() {
  [[ -f $STATE_PATH ]] || return 0
  # The embedded JavaScript uses template literals; the shell must not expand them.
  # shellcheck disable=SC2016
  node -e '
const fs = require("fs");
const path = process.argv[1];
try {
  const state = JSON.parse(fs.readFileSync(path, "utf8"));
  const keys = ["HTTPS_PROXY", "https_proxy", "NODE_EXTRA_CA_CERTS"];
  const noProxyKeys = ["NO_PROXY", "no_proxy"];
  if (state.version !== 1 || typeof state.settings?.existed !== "boolean" ||
      typeof state.settings?.envExisted !== "boolean" ||
      typeof state.soulConfig?.existed !== "boolean" ||
      typeof state.soulConfig?.dreamDisableCache?.existed !== "boolean" ||
      typeof state.soulConfig?.commentAdded !== "boolean" ||
      !keys.every((key) => typeof state.settings?.env?.[key]?.preExisting === "boolean") ||
      !noProxyKeys.every((key) => typeof state.settings?.noProxy?.[key]?.preExisting === "boolean" &&
        Array.isArray(state.settings.noProxy[key].added))) {
    throw new Error("unsupported or incomplete state schema");
  }
} catch (error) {
  console.error(`Invalid companion state in ${path}: ${error.message}`);
  process.exit(1);
}
' "$STATE_PATH"
}

write_companion_state() {
  [[ -f $STATE_PATH ]] && return 0
  # The embedded JavaScript uses template literals; the shell must not expand them.
  # shellcheck disable=SC2016
  node -e '
const fs = require("fs");
const { randomUUID } = require("crypto");
const [statePath, settingsPath, soulPath, proxyUrl, caPem] = process.argv.slice(1);
let root = {};
const settingsExisted = fs.existsSync(settingsPath);
if (settingsExisted) root = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
const env = root.env || {};
const own = (key) => Object.prototype.hasOwnProperty.call(env, key);
const locals = ["localhost", "127.0.0.1", "::1"];
const entries = (value) => String(value || "").split(",").map((part) => part.trim()).filter(Boolean);
const managed = {};
for (const [key, value] of [
  ["HTTPS_PROXY", proxyUrl], ["https_proxy", proxyUrl], ["NODE_EXTRA_CA_CERTS", caPem],
]) {
  managed[key] = own(key)
    ? { preExisting: true, value: env[key] }
    : { preExisting: false, value };
}
const noProxy = {};
for (const key of ["NO_PROXY", "no_proxy"]) {
  const present = new Set(entries(env[key]));
  noProxy[key] = {
    preExisting: own(key),
    added: locals.filter((entry) => !present.has(entry)),
  };
}
const soulExisted = fs.existsSync(soulPath);
const soulSource = soulExisted ? fs.readFileSync(soulPath, "utf8") : "";
const lines = soulSource ? soulSource.replace(/\n$/, "").split("\n") : [];
const dreamIndex = lines.findIndex((line) => line.startsWith("DREAM_DISABLE_CACHE="));
const comment = "# soul-jar companion: a canonicalizing proxy fronts sessions.";
const state = {
  version: 1,
  settings: {
    existed: settingsExisted,
    envExisted: Object.prototype.hasOwnProperty.call(root, "env"),
    env: managed,
    noProxy,
  },
  soulConfig: {
    existed: soulExisted,
    dreamDisableCache: {
      existed: dreamIndex !== -1,
      line: dreamIndex === -1 ? null : lines[dreamIndex].replace(/\r$/, ""),
    },
    commentAdded: dreamIndex === -1 || dreamIndex === 0 || lines[dreamIndex - 1] !== comment,
  },
};
const temporary = `${statePath}.${process.pid}.${randomUUID()}`;
fs.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
fs.renameSync(temporary, statePath);
' "$STATE_PATH" "$SETTINGS_PATH" "$SOUL_CONFIG_PATH" "$PROXY_URL" "$CA_PEM"
}

ensure_companion_state() {
  if [[ -f $STATE_PATH ]]; then
    validate_companion_state
  elif ((DRY_RUN)); then
    printf 'DRY-RUN: write ownership state to %q\n' "$STATE_PATH"
  else
    write_companion_state
  fi
}

soul_config_transform() {
  local mode=$1 action=$2
  # The embedded JavaScript uses template literals; the shell must not expand them.
  # shellcheck disable=SC2016
  node -e '
const fs = require("fs");
const [path, statePath, mode, action] = process.argv.slice(1);
const comment = "# soul-jar companion: a canonicalizing proxy fronts sessions.";
const original = fs.existsSync(path) ? fs.readFileSync(path, "utf8") : "";
let lines = original ? original.replace(/\n$/, "").split("\n") : [];
const index = lines.findIndex((line) => line.startsWith("DREAM_DISABLE_CACHE="));
if (mode === "install") {
  if (index === -1) lines.push(comment, "DREAM_DISABLE_CACHE=0");
  else {
    lines[index] = "DREAM_DISABLE_CACHE=0";
    if (index === 0 || lines[index - 1] !== comment) lines.splice(index, 0, comment);
  }
} else if (fs.existsSync(statePath)) {
  let state;
  try { state = JSON.parse(fs.readFileSync(statePath, "utf8")); }
  catch (error) { console.error(`Invalid companion state in ${statePath}: ${error.message}`); process.exit(1); }
  const prior = state.soulConfig;
  if (index !== -1 && lines[index] === "DREAM_DISABLE_CACHE=0") {
    if (prior.dreamDisableCache.existed) {
      lines[index] = prior.dreamDisableCache.line;
      if (prior.commentAdded && index > 0 && lines[index - 1] === comment) lines.splice(index - 1, 1);
    } else {
      lines.splice(index, 1);
      if (prior.commentAdded && index > 0 && lines[index - 1] === comment) lines.splice(index - 1, 1);
    }
  }
  const desired = lines.length ? `${lines.join("\n")}\n` : "";
  if (!prior.existed && desired === "") {
    if (action === "status") process.stdout.write(fs.existsSync(path) ? "change" : "same");
    else fs.rmSync(path, { force: true });
    process.exit(0);
  }
} else if (index === -1) {
  lines.push("DREAM_DISABLE_CACHE=auto");
} else {
  lines[index] = "DREAM_DISABLE_CACHE=auto";
  if (index > 0 && lines[index - 1] === comment) lines.splice(index - 1, 1);
}
const desired = lines.length ? `${lines.join("\n")}\n` : "";
if (action === "status") process.stdout.write(original === desired ? "same" : "change");
else fs.writeFileSync(path, desired);
' "$SOUL_CONFIG_PATH" "$STATE_PATH" "$mode" "$action"
}

soul_config_status() {
  soul_config_transform "$1" status
}

write_soul_config() {
  soul_config_transform "$1" write
}

apply_soul_config() {
  local mode=$1 state value
  state=$(soul_config_status "$mode")
  [[ $state == change ]] || return 0
  run_mutation mkdir -p "$SOUL_JAR_DIR"
  if ((DRY_RUN)); then
    if [[ $mode == install ]]; then value=0; else value=auto; fi
    printf 'DRY-RUN: set DREAM_DISABLE_CACHE=%s in %q\n' \
      "$value" "$SOUL_CONFIG_PATH"
  else
    write_soul_config "$mode"
  fi
}

prepare_checkout() {
  if [[ -e $INSTALL_DIR ]]; then
    git -C "$INSTALL_DIR" rev-parse --git-dir >/dev/null 2>&1 || \
      die "$INSTALL_DIR exists but is not a git repository; nothing was deleted"
    run_mutation git -C "$INSTALL_DIR" fetch --depth 1 origin "$BRANCH"
    run_mutation git -C "$INSTALL_DIR" reset --hard "origin/$BRANCH"
  else
    run_mutation mkdir -p "$(dirname "$INSTALL_DIR")"
    run_mutation git clone --depth 1 --branch "$BRANCH" "$REPOSITORY_URL" "$INSTALL_DIR"
  fi
}

install_dependencies() {
  local npm_cache="$INSTALL_DIR/.npm-cache"
  if ((DRY_RUN)); then
    print_command env "npm_config_cache=$npm_cache" npm --prefix "$INSTALL_DIR" ci --omit=dev
    return
  fi
  npm_config_cache=$npm_cache npm --prefix "$INSTALL_DIR" ci --omit=dev
}

service_file() {
  if [[ $PLATFORM == linux ]]; then
    printf '%s' "$HOME/.config/systemd/user/cache-fix-proxy.service"
  else
    printf '%s' "$HOME/Library/LaunchAgents/com.cnighswonger.cache-fix-proxy.plist"
  fi
}

service_has_plist_value() {
  local path=$1 key=$2 value=$3
  awk -v key_line="<key>$key</key>" -v value_line="<string>$value</string>" '
    {
      line = $0
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", line)
      if (previous == key_line && line == value_line) found = 1
      previous = line
    }
    END { exit found ? 0 : 1 }
  ' "$path"
}

service_has_companion_mode() {
  local path ca_dir
  path=$(service_file)
  ca_dir="$CLAUDE_DIR/cache-fix-ca"
  [[ -f $path ]] || return 1
  if [[ $PLATFORM == linux ]]; then
    grep -Fxq 'Environment=CACHE_FIX_FORWARD_PROXY=on' "$path" || return 1
    grep -Fxq 'Environment=CACHE_FIX_ENTRYPOINT_BRIDGE=1' "$path" || return 1
  else
    service_has_plist_value "$path" CACHE_FIX_FORWARD_PROXY on || return 1
    service_has_plist_value "$path" CACHE_FIX_ENTRYPOINT_BRIDGE 1 || return 1
  fi
  if [[ $CLAUDE_DIR != "$HOME/.claude" ]]; then
    grep -Fq 'CACHE_FIX_CA_DIR' "$path" || return 1
    grep -Fq "$ca_dir" "$path" || return 1
  fi
}

run_service_installer() {
  local force=${1:-0} output rc
  local command=(env CACHE_FIX_FORWARD_PROXY=on CACHE_FIX_ENTRYPOINT_BRIDGE=1 \
    CACHE_FIX_PROXY_PORT="$PORT" \
    CACHE_FIX_CA_DIR="$CLAUDE_DIR/cache-fix-ca" node "$INSTALL_DIR/bin/claude-via-proxy.mjs" install-service)
  ((force)) && command+=(--force)
  if ((DRY_RUN)); then
    print_command "${command[@]}"
    return
  fi
  set +e
  output=$("${command[@]}" 2>&1)
  rc=$?
  set -e
  printf '%s\n' "$output"
  if ((rc == 0)); then
    return
  fi
  if [[ $output == *already-installed* ]]; then
    return 10
  fi
  return "$rc"
}

activate_linux_service() {
  local was_active=0
  systemctl_user is-active --quiet cache-fix-proxy.service && was_active=1
  systemctl_mutation daemon-reload
  systemctl_mutation enable --now cache-fix-proxy.service
  systemctl_mutation enable --now cache-fix-proxy-healthcheck.timer
  if ((was_active)); then
    systemctl_mutation restart cache-fix-proxy.service
  fi
}

systemctl_mutation() {
  if ((DRY_RUN)); then
    if [[ -n $SYSTEMCTL_ENV ]]; then
      print_command env "XDG_RUNTIME_DIR=$SYSTEMCTL_ENV" systemctl --user "$@"
    else
      print_command systemctl --user "$@"
    fi
  else
    systemctl_user "$@"
  fi
}

activate_launchd_service() {
  local domain label="com.cnighswonger.cache-fix-proxy" plist
  domain="gui/$(id -u)"
  plist=$(service_file)
  if launchctl print "$domain/$label" >/dev/null 2>&1; then
    run_mutation launchctl bootout "$domain" "$plist"
  fi
  run_mutation launchctl bootstrap "$domain" "$plist"
  run_mutation launchctl enable "$domain/$label"
  run_mutation launchctl kickstart -k "$domain/$label"
}

install_service() {
  if [[ ${SOUL_JAR_COMPANION_SKIP_SERVICE:-0} == 1 ]]; then
    printf 'Test-only: service installation skipped by SOUL_JAR_COMPANION_SKIP_SERVICE=1\n'
    return
  fi
  local rc=0
  if ((DRY_RUN)); then
    run_service_installer
    if [[ -f $(service_file) ]] && ! service_has_companion_mode; then
      run_service_installer 1
    fi
    if [[ $PLATFORM == linux ]]; then
      activate_linux_service
    else
      activate_launchd_service
    fi
    return
  fi
  run_service_installer || rc=$?
  if ((rc == 10)); then
    if service_has_companion_mode; then
      printf 'Existing service already has the required companion environment.\n'
    else
      printf 'Upgrading existing service with the required companion environment.\n'
      run_service_installer 1
    fi
  elif ((rc != 0)); then
    die "install-service failed with exit code $rc"
  fi

  if [[ $PLATFORM == linux ]]; then
    activate_linux_service
  else
    activate_launchd_service
  fi
}

service_is_active() {
  [[ ${SOUL_JAR_COMPANION_SKIP_SERVICE:-0} == 1 ]] && return 0
  if [[ $PLATFORM == linux ]]; then
    systemctl_user is-active --quiet cache-fix-proxy.service
  else
    launchctl print "gui/$(id -u)/com.cnighswonger.cache-fix-proxy" >/dev/null 2>&1
  fi
}

guard_port() {
  if ((DRY_RUN)); then
    printf 'DRY-RUN: verify port %s is not owned by an unsupervised instance\n' "$PORT"
    return
  fi
  if curl -fsS --max-time 2 "http://127.0.0.1:$PORT/health" >/dev/null 2>&1 && \
    ! service_is_active; then
    cat >&2 <<EOF
soul-jar companion: port $PORT answers, but the managed cache-fix service is not active.
Stop the unsupervised instance yourself, then re-run. For example, find its terminal or PID with:
  lsof -nP -iTCP:$PORT -sTCP:LISTEN
No process was killed and Claude/soul-jar settings were not touched.
EOF
    exit 1
  fi
}

wait_for_health() {
  local attempt
  if [[ ${SOUL_JAR_COMPANION_SKIP_SERVICE:-0} == 1 ]]; then
    printf 'Test-only: health polling skipped with the stubbed service.\n'
    return
  fi
  ((DRY_RUN)) && { printf 'DRY-RUN: poll http://127.0.0.1:%s/health up to 30 times\n' "$PORT"; return; }
  for ((attempt = 1; attempt <= 30; attempt++)); do
    curl -fsS --max-time 2 "http://127.0.0.1:$PORT/health" >/dev/null 2>&1 && return
    sleep 1
  done
  die "proxy did not become healthy at http://127.0.0.1:$PORT/health"
}

wait_for_ca() {
  local attempt
  ((DRY_RUN)) && { printf 'DRY-RUN: wait for %q\n' "$CA_PEM"; return; }
  for ((attempt = 1; attempt <= 30; attempt++)); do
    [[ -f $CA_PEM ]] && return
    sleep 1
  done
  die "proxy CA was not created at $CA_PEM"
}

uninstall_service() {
  if [[ ${SOUL_JAR_COMPANION_SKIP_SERVICE:-0} == 1 ]]; then
    printf 'Test-only: service uninstall skipped by SOUL_JAR_COMPANION_SKIP_SERVICE=1\n'
    return
  fi
  local launcher="$INSTALL_DIR/bin/claude-via-proxy.mjs" output rc
  [[ -f $launcher ]] || die "cannot uninstall service: $launcher is missing (checkout was left untouched)"
  if ((DRY_RUN)); then
    print_command node "$launcher" uninstall-service
    return
  fi
  set +e
  output=$(node "$launcher" uninstall-service 2>&1)
  rc=$?
  set -e
  printf '%s\n' "$output"
  ((rc == 0)) || [[ $output == *not-installed* ]] || die "uninstall-service failed with exit code $rc"
}

verify_command() {
  if [[ $PLATFORM == linux ]]; then
    if [[ -n $SYSTEMCTL_ENV ]]; then
      printf 'XDG_RUNTIME_DIR=%q systemctl --user status cache-fix-proxy' "$SYSTEMCTL_ENV"
    else
      printf 'systemctl --user status cache-fix-proxy'
    fi
  else
    printf 'launchctl print gui/%s/com.cnighswonger.cache-fix-proxy' "$(id -u)"
  fi
}

print_install_summary() {
  local outcome="installed"
  ((DRY_RUN)) && outcome="planned (dry run; no changes made)"
  cat <<EOF

soul-jar companion $outcome.
  Checkout:      $INSTALL_DIR
  Service:       $(service_file)
  Claude config: $SETTINGS_PATH
  Proxy CA:      $CA_PEM
  soul-jar:      $SOUL_CONFIG_PATH
EOF
  if [[ $PLATFORM == linux ]]; then
    printf '  Health timer:  %s\n' "$HOME/.config/systemd/user/cache-fix-proxy-healthcheck.timer"
  fi
  if [[ -n $BACKUP_PATH ]]; then
    printf '  Settings backup: %s\n' "$BACKUP_PATH"
  fi
  cat <<EOF

Verify:
  $(verify_command)
  curl -fsS http://127.0.0.1:$PORT/health
  Your next soul-jar dream line in $SOUL_JAR_DIR/log should show cache_read > 0.

Undo:
  curl -fsSL "$RAW_INSTALLER_URL/$BRANCH/install.sh" | bash -s -- --uninstall --branch "$BRANCH" --dir "$INSTALL_DIR" --port "$PORT"
EOF
}

print_uninstall_summary() {
  cat <<EOF

soul-jar companion wiring removed.
  Service:       $(service_file)
  Claude config: $SETTINGS_PATH
  soul-jar:      $SOUL_CONFIG_PATH
  Checkout kept: $INSTALL_DIR
EOF
  if ((HAD_STATE)); then
    printf 'Only values recorded as companion-owned were removed.\n'
  else
    printf 'Legacy fallback completed; review the settings backup if ownership was ambiguous.\n'
  fi
  if [[ -n $BACKUP_PATH ]]; then
    printf '  Settings backup: %s\n' "$BACKUP_PATH"
  fi
}

install_companion() {
  basic_preflight
  settings_status install >/dev/null
  soul_config_status install >/dev/null
  validate_companion_state
  service_preflight
  prepare_checkout
  install_dependencies
  install_service
  guard_port
  wait_for_health
  wait_for_ca
  ensure_companion_state
  apply_settings install
  apply_soul_config install
  print_install_summary
}

uninstall_companion() {
  preflight
  if [[ -f $STATE_PATH ]]; then
    HAD_STATE=1
    validate_companion_state
  else
    printf 'Companion ownership state is missing at %s; using conservative equality-based uninstall.\n' \
      "$STATE_PATH"
  fi
  backup_settings
  uninstall_service
  apply_settings uninstall
  apply_soul_config uninstall
  run_mutation rm -f "$STATE_PATH"
  print_uninstall_summary
}

main() {
  parse_args "$@"
  set_paths
  if ((UNINSTALL)); then
    uninstall_companion
  else
    install_companion
  fi
}

main "$@"
