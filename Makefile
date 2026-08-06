.PHONY: test e2e e2e-build e2e-clean e2e-preflight changelog

# Deterministic test tier — hermetic regression suite (no Obsidian required):
# extension smoke (node), pi-settings tier, prune-lint guard, hot-cache guard.
# cli-smoke/daily-append/read-canvas skip with exit 0 when Obsidian is not
# running, so the target is safe in any environment.
# Requires node_modules (jiti + tsc): run `npm ci` first.
test:
	bash tests/cli-smoke.sh
	bash tests/regression/daily-append.sh
	bash tests/regression/read-canvas.sh
	bash tests/regression/hot-cache-guard.sh
	bash tests/regression/pi-settings-tier.sh
	bash tests/regression/prune-lint-guard.sh
	node tests/extension-smoke.mjs


# AC12: preflight runs before docker build; fails fast (exit 2) if credentials
# are missing or malformed, before any image build or container work begins.
# Accepts either an OAuth login (claudeAiOauth.accessToken) or an API key
# (api_key) — whichever shape `claude login` produced on this host.
e2e-preflight:
	@command -v jq >/dev/null 2>&1 || { \
	  echo "Error: jq is required on the host but was not found on PATH"; \
	  exit 2; }
	@[ -f ~/.claude/.credentials.json ] || { \
	  echo "Error: ~/.claude/.credentials.json not found — run 'claude login' first"; \
	  exit 2; }
	@jq -e '(.claudeAiOauth.accessToken // .api_key) | type == "string" and length > 0' \
	  ~/.claude/.credentials.json >/dev/null 2>&1 || { \
	  echo "Error: ~/.claude/.credentials.json has neither a non-empty claudeAiOauth.accessToken nor a non-empty api_key — run 'claude login' first"; \
	  exit 2; }

e2e-build:
	docker build -f tests/e2e/Dockerfile -t agents-memo-e2e:latest .

# Full local tier: preflight → build → run with credentials + working tree.
# On Linux hosts add --security-opt apparmor=unconfined if Obsidian crashes
# with SIGTRAP (see tests/e2e/README.md — AppArmor section).
#
# Credentials are mounted directly at /root/.claude/.credentials.json so the
# `claude` CLI inside the container picks them up via its normal config path
# (OAuth or api_key, whichever the file holds). No env-var key is passed,
# so nothing leaks through `docker inspect` or host shell history.
e2e: e2e-preflight e2e-build
	docker run --rm \
	  -e ENTRYPOINT_TYPE=local \
	  -v "$(PWD):/opt/plugin-src:ro" \
	  -v "$$HOME/.claude/.credentials.json:/root/.claude/.credentials.json:ro" \
	  agents-memo-e2e:latest

e2e-clean:
	docker image rm agents-memo-e2e:latest 2>/dev/null || true

changelog:
	sed -i '/^## \[Unreleased\]/,/^## \[/{/^## \[Unreleased\]/d;/^## \[/!d}' CHANGELOG.md
	git cliff --unreleased --prepend CHANGELOG.md
