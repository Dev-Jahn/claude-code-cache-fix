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
   `${XDG_DATA_HOME:-$HOME/.local/share}/claude-code-cache-fix` and runs
   `npm ci --omit=dev` against this branch's tracked `package-lock.json`. npm's cache is
   kept inside the checkout at `.npm-cache`.
2. Installs the repository's existing systemd user service and healthcheck timer, or
   its launchd agent, with forward-proxy mode and
   `CACHE_FIX_ENTRYPOINT_BRIDGE=1` enabled.
3. Waits for the proxy health endpoint and its local CA.
4. Backs up and updates `${CLAUDE_CONFIG_DIR:-$HOME/.claude}/settings.json` with
   `HTTPS_PROXY`, `https_proxy`, `NODE_EXTRA_CA_CERTS`, `NO_PROXY`, and `no_proxy`.
5. Sets `DREAM_DISABLE_CACHE=0` in
   `${SOUL_JAR_HOME:-$HOME/.soul-jar}/config`.

The checkout is installer-owned. Re-running the installer fetches the selected branch
and hard-resets the checkout to `origin/<branch>`; do not keep local changes there. If
the target exists but is not a Git repository, the installer stops and deletes nothing.
The installer also owns `.companion-state.json` in that checkout. It records which
settings, no-proxy tokens, and soul-jar config line existed before the first install so
uninstall can restore that ownership boundary. A second identical install creates no
new settings backup and changes nothing outside the checkout. Git's `FETCH_HEAD` and
reflog plus `.npm-cache` may still churn inside the installer-owned checkout.
Re-running the installer also upgrades a managed service definition that predates the
entrypoint bridge flag.

The installer never sets or changes `ANTHROPIC_BASE_URL`. It stops before making any
change if Claude settings already contain that key, if either `HTTPS_PROXY` or
`https_proxy` points at a different proxy, or if `NODE_EXTRA_CA_CERTS` points at a
different file. To combine this proxy's CA with another component or corporate root,
publish CAs through the repository's `ca-trust.d` contract and use its merged bundle;
the installer will not silently replace an existing CA path.

Useful options include `--dry-run`, `--branch <name>`, `--dir <checkout>`, and
`--port <N>`. The checkout path must contain no whitespace because the upstream systemd
unit renders its executable and working-directory paths unquoted; choose a space-free
`--dir`. Run the downloaded file with `--help` for the complete list.

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
and consults `.companion-state.json` to remove only keys and no-proxy tokens created by
the companion. Pre-existing identical managed values survive. It restores the exact
prior `DREAM_DISABLE_CACHE=` line, or removes the line and companion comment when the
installer added them. A settings or soul-jar config file created by the installer is
removed again when nothing else was added to it. The ownership state is then removed.

If `.companion-state.json` is missing—for example after an older install or a wiped
checkout—uninstall says that it is using the conservative legacy fallback. That fallback
removes managed proxy/CA values only when they still equal the installer's values, strips
the three local tokens from both no-proxy lists, and sets `DREAM_DISABLE_CACHE=auto`.

The checkout, `.npm-cache`, settings backups, soul-jar data, proxy CA, and logs are kept.
With valid ownership state, pre-existing managed values and tokens are not deleted. One
byte-preservation limitation remains: a CRLF-terminated soul-jar config can have the
managed DREAM line's terminator normalized to LF across an install/uninstall round trip.
Values and other lines are preserved, but use LF if exact line-ending preservation is
required.

Backups are named
`settings.json.bak.soul-jar-companion.<epoch>` beside `settings.json`.
