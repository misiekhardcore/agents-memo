# agents-memo E2E harness image (CI fast tier).
#
# Cache-optimized layer order: base OS → Obsidian → entrypoints. Rare changes
# go first so frequent entrypoint edits don't bust the upper layers.
#
# Pinning policy (AC15): no `latest` tags. Bump VERSION envs deliberately and
# rebuild the image to validate (push to trigger CI, or rebuild locally).
#
# AC2 — broken docs blow up the image build by design. The install steps
# below mirror the published prerequisites (Obsidian 1.12.7+ on $PATH). If an
# upstream URL or package shape changes, the failing RUN surfaces it.
#
# The image intentionally contains no Node or `claude` CLI — the CI tier only
# exercises the shell-level CLI stack (register → boot → cli-smoke).

# ── Layer 1 — base OS + Electron / Xvfb runtime deps ─────────────────────────
FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive \
    TZ=UTC \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8

RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        dbus-x11 \
        fontconfig \
        fonts-liberation \
        git \
        gnupg \
        jq \
        libasound2t64 \
        libatk-bridge2.0-0t64 \
        libatk1.0-0t64 \
        libcairo2 \
        libdbus-1-3 \
        libdrm2 \
        libfuse2t64 \
        libgbm1 \
        libgtk-3-0t64 \
        libnotify4 \
        libnss3 \
        libpango-1.0-0 \
        libsecret-1-0 \
        libxcomposite1 \
        libxdamage1 \
        libxfixes3 \
        libxrandr2 \
        libxshmfence1 \
        libxss1 \
        libxtst6 \
        xdg-utils \
        xvfb \
    && rm -rf /var/lib/apt/lists/*

# ── Layer 2 — Obsidian ───────────────────────────────────────────────────────
# AppImage extraction (vs. running the AppImage directly) sidesteps the FUSE
# mount that requires SYS_ADMIN inside containers. The 1.12.7 AppImage ships
# two binaries: `obsidian` (the Electron GUI) and `obsidian-cli` (the IPC
# client). Per skills/wiki/references/cli-setup.md, `obsidian` on $PATH refers
# to the CLI binary; the GUI is launched explicitly via AppRun.
ENV OBSIDIAN_VERSION=1.12.7

RUN curl -fsSL \
        "https://github.com/obsidianmd/obsidian-releases/releases/download/v${OBSIDIAN_VERSION}/Obsidian-${OBSIDIAN_VERSION}.AppImage" \
        -o /tmp/Obsidian.AppImage \
 && chmod +x /tmp/Obsidian.AppImage \
 && cd /opt && /tmp/Obsidian.AppImage --appimage-extract \
 && mv /opt/squashfs-root /opt/Obsidian \
 && ln -s /opt/Obsidian/obsidian-cli /usr/local/bin/obsidian \
 && rm /tmp/Obsidian.AppImage

# Runtime defaults consumed by entrypoint-ci.sh (overridable via docker run -e).
ENV PLUGIN_SRC=/opt/plugin-src \
    VAULT_PATH=/tmp/vault

# ── Layer 3 — entrypoints and helpers ────────────────────────────────────────
# Most-frequently-changed layer; bottom of the stack.
COPY tests/e2e/register-vault.sh \
     tests/e2e/wait-for-obsidian.sh \
     tests/e2e/entrypoint-ci.sh \
     /e2e/
RUN chmod +x /e2e/*.sh

# Shell-form ENTRYPOINT so ${ENTRYPOINT_TYPE} expands at run time.
# ENTRYPOINT_TYPE=ci → CI fast tier (no auth, no claude calls)
ENTRYPOINT bash /e2e/entrypoint-${ENTRYPOINT_TYPE:-ci}.sh
