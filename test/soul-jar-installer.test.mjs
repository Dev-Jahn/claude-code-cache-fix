import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileP = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const INSTALLER = resolve(__dirname, "..", "install.sh");

async function makeFixture() {
  const root = await mkdtemp(join(tmpdir(), "soul-jar-installer-test-"));
  const home = join(root, "home");
  const claudeDir = join(home, "claude-override");
  const soulJarDir = join(home, "soul-jar-override");
  const checkout = join(root, "checkout");
  const source = join(root, "source");
  await Promise.all([
    mkdir(join(claudeDir, "cache-fix-ca"), { recursive: true }),
    mkdir(soulJarDir, { recursive: true }),
    mkdir(source, { recursive: true }),
  ]);
  await writeFile(join(claudeDir, "cache-fix-ca", "ca.pem"), "fixture ca\n");
  await writeFile(
    join(source, "package.json"),
    `${JSON.stringify({ name: "installer-fixture", version: "1.0.0", private: true })}\n`,
  );
  await writeFile(
    join(source, "package-lock.json"),
    `${JSON.stringify({
      name: "installer-fixture",
      version: "1.0.0",
      lockfileVersion: 3,
      requires: true,
      packages: { "": { name: "installer-fixture", version: "1.0.0" } },
    })}\n`,
  );
  await execFileP("git", ["init", "--initial-branch=soul-jar"], { cwd: source });
  await execFileP("git", ["config", "user.name", "Fixture"], { cwd: source });
  await execFileP("git", ["config", "user.email", "fixture@example.invalid"], { cwd: source });
  await execFileP("git", ["add", "package.json", "package-lock.json"], { cwd: source });
  await execFileP("git", ["commit", "-m", "fixture"], { cwd: source });
  await execFileP("git", ["clone", "--branch", "soul-jar", source, checkout]);

  return {
    root,
    home,
    claudeDir,
    soulJarDir,
    checkout,
    source,
    settingsPath: join(claudeDir, "settings.json"),
    soulConfigPath: join(soulJarDir, "config"),
    env: {
      ...process.env,
      HOME: home,
      CLAUDE_CONFIG_DIR: claudeDir,
      SOUL_JAR_HOME: soulJarDir,
      XDG_DATA_HOME: join(home, "xdg-data"),
      SOUL_JAR_COMPANION_SKIP_SERVICE: "1",
    },
  };
}

async function runInstaller(fixture, args = []) {
  return execFileP("bash", [INSTALLER, "--dir", fixture.checkout, ...args], {
    env: fixture.env,
  });
}

async function enableFixtureServices(fixture, kind) {
  const launcherDir = join(fixture.checkout, "bin");
  const serviceLog = join(fixture.root, "service-install.log");
  const bashEnv = join(fixture.root, "fixture-commands.sh");
  await mkdir(launcherDir, { recursive: true });
  await writeFile(
    join(launcherDir, "claude-via-proxy.mjs"),
    `import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
const force = process.argv.includes("--force");
const kind = process.env.SOUL_JAR_TEST_SERVICE_KIND;
const path = kind === "launchd"
  ? join(process.env.HOME, "Library", "LaunchAgents", "com.cnighswonger.cache-fix-proxy.plist")
  : join(process.env.HOME, ".config", "systemd", "user", "cache-fix-proxy.service");
appendFileSync(process.env.SOUL_JAR_TEST_SERVICE_LOG, force ? "force\\n" : "normal\\n");
if (existsSync(path) && !force) {
  process.stderr.write("[install-service] already-installed: " + path + "\\n");
  process.exit(1);
}
mkdirSync(dirname(path), { recursive: true });
const caDir = join(process.env.CLAUDE_CONFIG_DIR, "cache-fix-ca");
const body = kind === "launchd"
  ? "<key>CACHE_FIX_FORWARD_PROXY</key>\\n<string>on</string>\\n<key>CACHE_FIX_CA_DIR</key>\\n<string>" + caDir + "</string>\\n<key>CACHE_FIX_ENTRYPOINT_BRIDGE</key>\\n<string>1</string>\\n"
  : "Environment=CACHE_FIX_FORWARD_PROXY=on\\nEnvironment=CACHE_FIX_CA_DIR=" + caDir + "\\nEnvironment=CACHE_FIX_ENTRYPOINT_BRIDGE=1\\n";
writeFileSync(path, body);
`,
  );
  await writeFile(
    bashEnv,
    `systemctl() { return 0; }
launchctl() { return 0; }
curl() { return 0; }
uname() { printf '%s\\n' '${kind === "launchd" ? "Darwin" : "Linux"}'; }
`,
  );
  delete fixture.env.SOUL_JAR_COMPANION_SKIP_SERVICE;
  fixture.env.BASH_ENV = bashEnv;
  fixture.env.SOUL_JAR_TEST_SERVICE_KIND = kind;
  fixture.env.SOUL_JAR_TEST_SERVICE_LOG = serviceLog;
  const platformProbe = await execFileP("bash", ["-c", "type systemctl; type launchctl; type curl; type uname; uname -s"], {
    env: fixture.env,
  });
  assert.match(platformProbe.stdout, /systemctl is a function/);
  assert.match(platformProbe.stdout, /launchctl is a function/);
  assert.match(platformProbe.stdout, /curl is a function/);
  assert.match(platformProbe.stdout, /uname is a function/);
  assert.match(platformProbe.stdout, new RegExp(kind === "launchd" ? "Darwin" : "Linux"));
  return {
    serviceLog,
    servicePath: kind === "launchd"
      ? join(fixture.home, "Library", "LaunchAgents", "com.cnighswonger.cache-fix-proxy.plist")
      : join(fixture.home, ".config", "systemd", "user", "cache-fix-proxy.service"),
  };
}

async function snapshotTree(root) {
  const result = {};

  async function visit(path, relative = "") {
    for (const name of (await readdir(path)).sort()) {
      const child = join(path, name);
      const childRelative = relative ? join(relative, name) : name;
      const metadata = await stat(child);
      if (metadata.isDirectory()) {
        result[`${childRelative}/`] = "directory";
        await visit(child, childRelative);
      } else {
        result[childRelative] = await readFile(child, "base64");
      }
    }
  }

  await visit(root);
  return result;
}

async function backupNames(claudeDir) {
  return (await readdir(claudeDir))
    .filter((name) => name.startsWith("settings.json.bak.soul-jar-companion."))
    .sort();
}

async function assertMissing(path) {
  await assert.rejects(readFile(path), { code: "ENOENT" });
}

test("--dry-run reports changes but performs zero writes", async () => {
  const fixture = await makeFixture();
  try {
    await writeFile(
      fixture.settingsPath,
      `${JSON.stringify({ env: { EXISTING: "keep", NO_PROXY: "corp.example" }, theme: "dark" }, null, 2)}\n`,
    );
    await writeFile(fixture.soulConfigPath, "OTHER=value\nDREAM_DISABLE_CACHE=auto\n");
    const before = await snapshotTree(fixture.root);

    const { stdout } = await runInstaller(fixture, ["--dry-run"]);

    assert.match(stdout, /DRY-RUN/);
    assert.match(stdout, /npm_config_cache=.*\.npm-cache/);
    assert.doesNotMatch(stdout, /npm .*install --omit=dev/);
    assert.deepEqual(await snapshotTree(fixture.root), before);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("--dry-run narrates the entrypoint bridge service environment", async () => {
  const fixture = await makeFixture();
  try {
    await enableFixtureServices(fixture, "systemd");
    const { stdout } = await runInstaller(fixture, ["--dry-run"]);
    assert.match(stdout, /CACHE_FIX_ENTRYPOINT_BRIDGE=1/);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

for (const kind of ["systemd", "launchd"]) {
  test(`${kind}: stale service without entrypoint bridge is force-regenerated`, async () => {
    const fixture = await makeFixture();
    try {
      const { serviceLog, servicePath } = await enableFixtureServices(fixture, kind);
      await mkdir(dirname(servicePath), { recursive: true });
      const previous = kind === "launchd"
        ? `<key>CACHE_FIX_FORWARD_PROXY</key>\n<string>on</string>\n<key>CACHE_FIX_CA_DIR</key>\n<string>${fixture.claudeDir}/cache-fix-ca</string>\n`
        : `Environment=CACHE_FIX_FORWARD_PROXY=on\nEnvironment=CACHE_FIX_CA_DIR=${fixture.claudeDir}/cache-fix-ca\n`;
      await writeFile(servicePath, previous);

      await runInstaller(fixture);

      const rendered = await readFile(servicePath, "utf8");
      if (kind === "launchd") {
        assert.match(
          rendered,
          /<key>CACHE_FIX_ENTRYPOINT_BRIDGE<\/key>\n<string>1<\/string>/,
        );
      } else {
        assert.match(rendered, /^Environment=CACHE_FIX_ENTRYPOINT_BRIDGE=1$/m);
      }
      assert.equal(await readFile(serviceLog, "utf8"), "normal\nforce\n");
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  test(`${kind}: current service with entrypoint bridge is left unchanged`, async () => {
    const fixture = await makeFixture();
    try {
      const { serviceLog, servicePath } = await enableFixtureServices(fixture, kind);
      await mkdir(dirname(servicePath), { recursive: true });
      const current = kind === "launchd"
        ? `<key>CACHE_FIX_FORWARD_PROXY</key>\n<string>on</string>\n<key>CACHE_FIX_CA_DIR</key>\n<string>${fixture.claudeDir}/cache-fix-ca</string>\n<key>CACHE_FIX_ENTRYPOINT_BRIDGE</key>\n<string>1</string>\n<!-- keep -->\n`
        : `Environment=CACHE_FIX_FORWARD_PROXY=on\nEnvironment=CACHE_FIX_CA_DIR=${fixture.claudeDir}/cache-fix-ca\nEnvironment=CACHE_FIX_ENTRYPOINT_BRIDGE=1\n# keep\n`;
      await writeFile(servicePath, current);

      const { stdout } = await runInstaller(fixture);

      assert.equal(await readFile(servicePath, "utf8"), current, stdout);
      assert.equal(await readFile(serviceLog, "utf8"), "normal\n");
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });
}

test("round trip restores absent settings and soul-jar config to absence", async () => {
  const fixture = await makeFixture();
  try {
    await runInstaller(fixture);
    const state = JSON.parse(
      await readFile(join(fixture.checkout, ".companion-state.json"), "utf8"),
    );
    assert.equal(state.settings.existed, false);
    assert.equal(state.soulConfig.existed, false);
    await runInstaller(fixture, ["--uninstall"]);

    await assertMissing(fixture.settingsPath);
    await assertMissing(fixture.soulConfigPath);
    await assertMissing(join(fixture.checkout, ".companion-state.json"));
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("round trip byte-preserves pre-existing local no-proxy entries", async () => {
  const fixture = await makeFixture();
  const initialSettings = `${JSON.stringify({
    env: {
      EXISTING: "keep",
      NO_PROXY: "corp.example,localhost,127.0.0.1",
      no_proxy: "::1,x.example",
    },
    theme: "dark",
  }, null, 2)}\n`;
  try {
    await writeFile(fixture.settingsPath, initialSettings);
    await runInstaller(fixture);
    const state = JSON.parse(
      await readFile(join(fixture.checkout, ".companion-state.json"), "utf8"),
    );
    assert.deepEqual(state.settings.noProxy.NO_PROXY.added, ["::1"]);
    assert.deepEqual(state.settings.noProxy.no_proxy.added, ["localhost", "127.0.0.1"]);
    await runInstaller(fixture, ["--uninstall"]);

    assert.equal(await readFile(fixture.settingsPath, "utf8"), initialSettings);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("round trip preserves pre-existing empty no-proxy keys", async () => {
  const fixture = await makeFixture();
  const initialSettings = `${JSON.stringify({ env: { NO_PROXY: "", no_proxy: "" } })}\n`;
  try {
    await writeFile(fixture.settingsPath, initialSettings);
    await runInstaller(fixture);
    await runInstaller(fixture, ["--uninstall"]);

    assert.equal(await readFile(fixture.settingsPath, "utf8"), initialSettings);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

for (const prior of ["DREAM_DISABLE_CACHE=1", "DREAM_DISABLE_CACHE=0"]) {
  test(`round trip restores exact pre-existing ${prior} line`, async () => {
    const fixture = await makeFixture();
    const initialSoul = `OTHER=value\n${prior}\nTAIL=keep\n`;
    try {
      await writeFile(fixture.soulConfigPath, initialSoul);
      await runInstaller(fixture);
      await runInstaller(fixture, ["--uninstall"]);

      assert.equal(await readFile(fixture.soulConfigPath, "utf8"), initialSoul);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });
}

test("round trip removes the DREAM line and comment added to an existing config", async () => {
  const fixture = await makeFixture();
  const initialSoul = "OTHER=value\nTAIL=keep\n";
  try {
    await writeFile(fixture.soulConfigPath, initialSoul);
    await runInstaller(fixture);
    await runInstaller(fixture, ["--uninstall"]);

    assert.equal(await readFile(fixture.soulConfigPath, "utf8"), initialSoul);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("round trip preserves pre-existing identical managed env values", async () => {
  const fixture = await makeFixture();
  const initialSettings = `${JSON.stringify({
    env: {
      EXISTING: "keep",
      HTTPS_PROXY: "http://127.0.0.1:9801",
      https_proxy: "http://127.0.0.1:9801",
      NODE_EXTRA_CA_CERTS: join(fixture.claudeDir, "cache-fix-ca", "ca.pem"),
    },
  })}\n`;
  try {
    await writeFile(fixture.settingsPath, initialSettings);
    await runInstaller(fixture);
    await runInstaller(fixture, ["--uninstall"]);

    assert.equal(await readFile(fixture.settingsPath, "utf8"), initialSettings);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("install then uninstall preserves unrelated settings and soul-jar config", async () => {
  const fixture = await makeFixture();
  const initialSettings = {
    env: {
      EXISTING: "keep exactly",
      NO_PROXY: "corp.example",
      no_proxy: "lower.example",
    },
    permissions: { allow: ["Read"] },
  };
  const initialSoul = "OTHER=value\nDREAM_DISABLE_CACHE=auto\nTAIL=keep\n";
  try {
    await writeFile(fixture.settingsPath, `${JSON.stringify(initialSettings, null, 4)}\n`);
    await writeFile(fixture.soulConfigPath, initialSoul);

    await runInstaller(fixture);
    const installed = JSON.parse(await readFile(fixture.settingsPath, "utf8"));
    assert.equal(installed.env.HTTPS_PROXY, "http://127.0.0.1:9801");
    assert.equal(installed.env.https_proxy, "http://127.0.0.1:9801");
    assert.equal(
      installed.env.NODE_EXTRA_CA_CERTS,
      join(fixture.claudeDir, "cache-fix-ca", "ca.pem"),
    );
    assert.deepEqual(installed.env.NO_PROXY.split(","), [
      "corp.example",
      "localhost",
      "127.0.0.1",
      "::1",
    ]);
    assert.deepEqual(installed.env.no_proxy.split(","), [
      "lower.example",
      "localhost",
      "127.0.0.1",
      "::1",
    ]);
    assert.match(await readFile(fixture.soulConfigPath, "utf8"), /DREAM_DISABLE_CACHE=0/);

    await runInstaller(fixture, ["--uninstall"]);
    const uninstalled = JSON.parse(await readFile(fixture.settingsPath, "utf8"));
    assert.deepEqual(uninstalled, initialSettings);
    assert.equal(await readFile(fixture.soulConfigPath, "utf8"), initialSoul);
    assert.equal((await backupNames(fixture.claudeDir)).length, 2);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("second install is idempotent and creates no backup", async () => {
  const fixture = await makeFixture();
  try {
    await writeFile(fixture.settingsPath, `${JSON.stringify({ env: { EXISTING: "keep" } })}\n`);
    await writeFile(fixture.soulConfigPath, "OTHER=value\n");

    await runInstaller(fixture);
    const settingsAfterFirst = await readFile(fixture.settingsPath);
    const soulAfterFirst = await readFile(fixture.soulConfigPath);
    const stateAfterFirst = await readFile(join(fixture.checkout, ".companion-state.json"));
    const backupsAfterFirst = await backupNames(fixture.claudeDir);
    const homeAfterFirst = await snapshotTree(fixture.home);
    await runInstaller(fixture);

    assert.deepEqual(await readFile(fixture.settingsPath), settingsAfterFirst);
    assert.deepEqual(await readFile(fixture.soulConfigPath), soulAfterFirst);
    assert.deepEqual(
      await readFile(join(fixture.checkout, ".companion-state.json")),
      stateAfterFirst,
    );
    assert.deepEqual(await backupNames(fixture.claudeDir), backupsAfterFirst);
    assert.deepEqual(await snapshotTree(fixture.home), homeAfterFirst);
    assert.equal(backupsAfterFirst.length, 1);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

for (const [name, conflictingEnv, message] of [
  [
    "ANTHROPIC_BASE_URL",
    { ANTHROPIC_BASE_URL: "http://127.0.0.1:9999" },
    /ANTHROPIC_BASE_URL/,
  ],
  [
    "different HTTPS_PROXY",
    { HTTPS_PROXY: "http://corporate.example:8443" },
    /HTTPS_PROXY/,
  ],
  [
    "different https_proxy",
    { https_proxy: "http://corporate.example:8443" },
    /https_proxy/,
  ],
  [
    "different NODE_EXTRA_CA_CERTS",
    { NODE_EXTRA_CA_CERTS: "/corporate/ca-bundle.pem" },
    /ca-trust\.d.*merged bundle/is,
  ],
]) {
  test(`${name} aborts before any mutation`, async () => {
    const fixture = await makeFixture();
    try {
      await writeFile(
        fixture.settingsPath,
        `${JSON.stringify({ env: { EXISTING: "keep", ...conflictingEnv }, theme: "dark" }, null, 2)}\n`,
      );
      await writeFile(fixture.soulConfigPath, "DREAM_DISABLE_CACHE=auto\n");
      const before = await snapshotTree(fixture.root);

      await assert.rejects(runInstaller(fixture), (error) => {
        assert.notEqual(error.code, 0);
        assert.match(error.stderr, message);
        return true;
      });
      assert.deepEqual(await snapshotTree(fixture.root), before);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });
}

test("uninstall removes only installer-owned current values", async () => {
  const fixture = await makeFixture();
  try {
    const proxyUrl = "http://127.0.0.1:9801";
    await writeFile(
      fixture.settingsPath,
      `${JSON.stringify({
        env: {
          HTTPS_PROXY: "http://changed-after-install.example:8080",
          https_proxy: proxyUrl,
          NODE_EXTRA_CA_CERTS: join(fixture.claudeDir, "cache-fix-ca", "ca.pem"),
          NO_PROXY: "corp.example,localhost,127.0.0.1,::1",
          no_proxy: "localhost,keep.example",
        },
      })}\n`,
    );
    await writeFile(
      fixture.soulConfigPath,
      "# soul-jar companion: a canonicalizing proxy fronts sessions.\nDREAM_DISABLE_CACHE=0\n",
    );

    const { stdout } = await runInstaller(fixture, ["--uninstall"]);
    assert.match(stdout, /ownership state.*missing.*conservative equality-based/is);
    const settings = JSON.parse(await readFile(fixture.settingsPath, "utf8"));
    assert.equal(settings.env.HTTPS_PROXY, "http://changed-after-install.example:8080");
    assert.ok(!("https_proxy" in settings.env));
    assert.ok(!("NODE_EXTRA_CA_CERTS" in settings.env));
    assert.equal(settings.env.NO_PROXY, "corp.example");
    assert.equal(settings.env.no_proxy, "keep.example");
    assert.equal(await readFile(fixture.soulConfigPath, "utf8"), "DREAM_DISABLE_CACHE=auto\n");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("lockfile mismatch fails at npm ci without an install fallback", async () => {
  const fixture = await makeFixture();
  try {
    const packagePath = join(fixture.source, "package.json");
    const packageJson = JSON.parse(await readFile(packagePath, "utf8"));
    packageJson.dependencies = { "left-pad": "1.3.0" };
    await writeFile(packagePath, `${JSON.stringify(packageJson)}\n`);
    await execFileP("git", ["add", "package.json"], { cwd: fixture.source });
    await execFileP("git", ["commit", "-m", "make lock stale"], { cwd: fixture.source });
    const lockBefore = await readFile(join(fixture.checkout, "package-lock.json"));

    await assert.rejects(runInstaller(fixture), (error) => {
      assert.notEqual(error.code, 0);
      assert.match(error.stderr, /npm error|npm ERR!/);
      return true;
    });
    assert.deepEqual(await readFile(join(fixture.checkout, "package-lock.json")), lockBefore);
    await assertMissing(join(fixture.home, ".npm"));
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("install directory containing whitespace is rejected before mutation", async () => {
  const fixture = await makeFixture();
  const spacedCheckout = join(fixture.root, "checkout with space");
  try {
    await execFileP("git", ["clone", "--branch", "soul-jar", fixture.source, spacedCheckout]);
    const before = await snapshotTree(fixture.root);

    await assert.rejects(
      runInstaller(fixture, ["--dir", spacedCheckout]),
      (error) => {
        assert.notEqual(error.code, 0);
        assert.match(error.stderr, /install directory.*whitespace.*space-free --dir/is);
        return true;
      },
    );
    assert.deepEqual(await snapshotTree(fixture.root), before);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});
