.PHONY: test e2e-build e2e-clean changelog

# Deterministic test tier — hermetic regression suite (no Obsidian required):
# extension smoke (node), pi-settings tier, prune-lint guard, index-section
# insert guard, lint-duplicate-headings guard, hot-cache guard.
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
	bash tests/regression/index-section-insert.sh
	bash tests/regression/lint-duplicate-headings.sh
	node tests/extension-smoke.mjs

e2e-build:
	docker build -f tests/e2e/Dockerfile -t agents-memo-e2e:latest .

e2e-clean:
	docker image rm agents-memo-e2e:latest 2>/dev/null || true

changelog:
	sed -i '/^## \[Unreleased\]/,/^## \[/{/^## \[Unreleased\]/d;/^## \[/!d}' CHANGELOG.md
	git cliff --unreleased --prepend CHANGELOG.md
