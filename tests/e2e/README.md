# E2E harness

Docker-based end-to-end harness that builds an Ubuntu image, boots Obsidian under Xvfb, and runs `tests/cli-smoke.sh` against a freshly scaffolded vault.

The same image is used by the GitHub Actions workflow (`.github/workflows/e2e.yml`) and for local debugging.

## Layout

|File|Purpose|
|-|-|
|`Dockerfile`|3-layer image: Ubuntu 24.04 → Obsidian AppImage → entrypoints|
|`entrypoint-ci.sh`|CI fast-tier sequence: scaffold vault → register → boot Xvfb/D-Bus/Obsidian → probe → run `cli-smoke.sh`|
|`register-vault.sh`|Writes `~/.config/obsidian/obsidian.json` with `cli: true` and the vault entry|
|`wait-for-obsidian.sh`|Compound readiness probe (`obsidian version && obsidian read path=wiki/hot.md`), 1s poll, 60s cap|

## Pinned versions

Bump in the Dockerfile and rebuild — no `latest` tags.

|Component|Version|Source|
|-|-|-|
|Base OS|`ubuntu:24.04`|`FROM` line|
|Obsidian|1.12.7|`OBSIDIAN_VERSION`|

## Build

From the repository root:

```bash
docker build -f tests/e2e/Dockerfile -t agents-memo-e2e:local .
```

Cold build: ~2–3 min. Warm rebuild (entrypoint changes only): <1s.

## Run the CI fast tier

```bash
docker run --rm \
  -e ENTRYPOINT_TYPE=ci \
  -v "$(pwd):/opt/plugin-src:ro" \
  agents-memo-e2e:local
```

Expected output (tail):

```text
entrypoint-ci: scaffolding vault at /tmp/vault
register-vault: registered /tmp/vault (id=...)
entrypoint-ci: starting Xvfb on :99
entrypoint-ci: starting D-Bus session
entrypoint-ci: launching Obsidian GUI
wait-for-obsidian: ready after 1s
entrypoint-ci: running tests/cli-smoke.sh
=== summary ===
  pass=60 fail=0
entrypoint-ci: cli-smoke.sh exited with 0
```

Total wall-clock: ~5–10 s after the image is built. Exit code 0 = green.

## Debug a failing run

Drop into the container before the entrypoint runs:

```bash
docker run --rm -it \
  -e ENTRYPOINT_TYPE=ci \
  -v "$(pwd):/opt/plugin-src:ro" \
  --entrypoint /bin/bash \
  agents-memo-e2e:local
```

Inside the container:

```bash
bash /e2e/entrypoint-ci.sh    # run the full sequence
cat /tmp/obsidian.log         # Obsidian / Electron stderr
cat /tmp/xvfb.log             # Xvfb stderr
obsidian version              # test the CLI directly
obsidian read path=wiki/hot.md
```

## Environment variables

|Variable|Default|Purpose|
|-|-|-|
|`ENTRYPOINT_TYPE`|`ci`|Selects the entrypoint script (only `ci` ships in the image)|
|`PLUGIN_SRC`|`/opt/plugin-src`|Where the plugin tree is mounted in the container|
|`VAULT_PATH`|`/tmp/vault`|Where the test vault is scaffolded|
|`DISPLAY_NUM`|`:99`|Xvfb display number|
|`WAIT_FOR_OBSIDIAN_TIMEOUT`|`60`|Readiness probe deadline (seconds)|

## Constraints

- Container is always run with `--rm`; no persistence between runs.
- Plugin tree is mounted **read-only** at `/opt/plugin-src`.
- No claude/Node in the image at all — the CI tier only exercises the shell-level CLI stack.
- `bin/setup-vault.sh` and `tests/cli-smoke.sh` are reused as-is — never modified.
- All assertions are shape-only — no content-match assertions exist anywhere in the harness (AC16).

## AppArmor on Linux hosts

CI passes `--security-opt apparmor=unconfined` to `docker run`. GitHub's `ubuntu-24.04` runners (and any native Linux Docker on Ubuntu 24.04+) apply the `docker-default` AppArmor profile, which blocks the user-namespace syscalls Chromium uses during Electron init even with `--no-sandbox`. Without the flag, Obsidian crashes with `SIGTRAP` mid-boot. Docker Desktop (macOS / Windows / WSL) runs containers in a linuxkit VM with no host AppArmor and is unaffected, so locally the flag is optional. Add it when reproducing a CI failure on a native Linux Docker host.
