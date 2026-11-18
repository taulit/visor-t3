#!/usr/bin/env bash
# Shared by the shell tests of this directory. They run the module next to
# Visor in the sandboxed headless shell of the Visor repository
# (scripts/nested.sh there: own HOME, session bus and keyring, so nothing
# reaches the session you are logged in to).
#
# VISOR_REPO is a checkout of https://github.com/taulit/visor with `pnpm build`
# done; default: ../visor next to this repository.

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
visor_repo="${VISOR_REPO:-$repo/../visor}"
uuid='visor-t3@taulit.github.io'
schema='org.gnome.shell.extensions.visor-t3'

# nested [options of nested.sh] -- command: the sandbox with Visor and this module.
nested() {
    [[ -x "$visor_repo/scripts/nested.sh" && -f "$visor_repo/build/metadata.json" ]] || {
        echo "No built Visor in $visor_repo: set VISOR_REPO to a checkout and run 'pnpm build' there." >&2
        exit 2
    }
    [[ -f "$repo/build/metadata.json" ]] || { echo "Run 'pnpm build' first." >&2; exit 2; }
    mkdir -p "$repo/.shell-test"
    VISOR_T3_REPO="$repo" "$visor_repo/scripts/nested.sh" --extension "$repo/build" "$@"
}

# inside: call first in the part of a test that runs in the sandbox.
inside() {
    source "$visor_repo/scripts/lib/shell.sh"
    source "$visor_repo/scripts/lib/keyring.sh"
    keyring_guard
    export GSETTINGS_SCHEMA_DIR="$HOME/.local/share/gnome-shell/extensions/$uuid/schemas"
    shell_wait_for 'visor !== null && visor.api !== null'
    shell_wait_for "Main.extensionManager.lookup('$uuid')?.state === 1 && visor.content.registry.get('t3') != null" 15
}

# The settings of the module, as the shell and the settings window see them.
gs() { gsettings set "$schema" "$@"; }
gg() { gsettings get "$schema" "$1"; }

# keyring_store ORIGIN TOKEN: stores the token the way the settings window does.
keyring_store() {
    keyring_guard
    printf '%s' "$2" | secret-tool store --label="Visor: T3 Code ($1)" \
        xdg:schema io.github.taulit.Visor.T3 origin "$1"
}

# keyring_lookup ORIGIN: prints the stored token, nothing when there is none.
keyring_lookup() {
    keyring_guard
    secret-tool lookup xdg:schema io.github.taulit.Visor.T3 origin "$1" 2>/dev/null || true
}

# t3_pair ORIGIN TOKEN: what pairing in the settings window leaves behind.
t3_pair() {
    keyring_store "$1" "$2"
    gs token-origin "$1"
    gs token-serial "$(($(gg token-serial) + 1))"
}

# All actors below the notch that carry a style class, as a JS expression.
content_find() {
    printf '%s' "(function find(a, out) { if (a.has_style_class_name && a.has_style_class_name('$1')) out.push(a); for (const c of a.get_children()) find(c, out); return out; })(visor.notch.root, [])"
}
