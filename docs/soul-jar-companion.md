# soul-jar companion installer

soul-jar resumes a just-ended Claude Code session once to generate its dream. The
headless resume has a different entrypoint prefix, so it cannot reuse the interactive
session's prompt cache on its own. This companion runs claude-code-cache-fix as a
supervised forward proxy, lets the entrypoint bridge canonicalize that transition, and
enables caching for the dream.

Forward-proxy mode leaves `ANTHROPIC_BASE_URL` unset, so Remote Control remains
available on Claude Code 2.1.196 and newer.

## Install

Requirements:

- Linux with a working systemd user manager, or macOS with launchd
- Git, curl, npm, and Node.js 18 or newer
- soul-jar installed and Claude Code already usable

Run:

```bash
curl -fsSL https://raw.githubusercontent.com/Dev-Jahn/claude-code-cache-fix/soul-jar/install.sh | bash
```

The installer:

1. Clones the `soul-jar` branch into
   `${XDG_DATA_HOME:-$HOME/.local/share}/claude-code-cache-fix` and installs production
   dependencies.
2. Installs the repository's existing systemd user service and healthcheck timer, or
   its launchd agent, with forward-proxy mode enabled.
3. Waits for the proxy health endpoint and its local CA.
4. Backs up and updates `${CLAUDE_CONFIG_DIR:-$HOME/.claude}/settings.json` with
   `HTTPS_PROXY`, `https_proxy`, `NODE_EXTRA_CA_CERTS`, `NO_PROXY`, and `no_proxy`.
5. Sets `DREAM_DISABLE_CACHE=0` in
   `${SOUL_JAR_HOME:-$HOME/.soul-jar}/config`.

The checkout is installer-owned. Re-running the installer fetches the selected branch
and hard-resets the checkout to `origin/<branch>`; do not keep local changes there. If
the target exists but is not a Git repository, the installer stops and deletes nothing.

The installer never sets or changes `ANTHROPIC_BASE_URL`. It stops before making any
change if Claude settings already contain that key, or if `HTTPS_PROXY` points at a
different proxy. This prevents reverse/forward proxy stacking and preserves an existing
corporate or local proxy.

Useful options include `--dry-run`, `--branch <name>`, `--dir <checkout>`, and
`--port <N>`. Run the downloaded file with `--help` for the complete list.

## Verify

Check the managed service and health endpoint:

```bash
# Linux
systemctl --user status cache-fix-proxy

# macOS
launchctl print "gui/$(id -u)/com.cnighswonger.cache-fix-proxy"

# Either platform
curl -fsS http://127.0.0.1:9801/health
```

After the next session ends, the next dream line in
`${SOUL_JAR_HOME:-$HOME/.soul-jar}/log` should show `cache_read` greater than zero.
The first request can still create a cache; the resumed dream is where reads should
appear.

## Undo

```bash
curl -fsSL https://raw.githubusercontent.com/Dev-Jahn/claude-code-cache-fix/soul-jar/install.sh | bash -s -- --uninstall
```

Uninstall creates a fresh Claude settings backup, stops and removes the managed service,
removes only companion-owned settings values, and restores
`DREAM_DISABLE_CACHE=auto`. It strips only `localhost`, `127.0.0.1`, and `::1` from the
two no-proxy lists and preserves all other entries. It keeps the checkout, settings
backups, soul-jar data, proxy CA, and logs; no user data is deleted.

Backups are named
`settings.json.bak.soul-jar-companion.<epoch>` beside `settings.json`.
