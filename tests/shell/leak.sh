#!/usr/bin/env bash
# Disables and enables an extension repeatedly in the sandboxed headless shell
# while the module is connected to the mock of tests/mock/, and fails if
# actors or signal handlers are left behind or the shell logs warnings.
# Two rounds: this module goes and comes back while Visor stays, then Visor
# goes and comes back and the module registers again.
#
# Usage: tests/shell/leak.sh [cycles]   (default 50, per round)
set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

if [[ "${1:-}" != --inside ]]; then
    nested --log "$repo/.shell-test/leak.log" -- "$repo/tests/shell/leak.sh" --inside "${1:-50}"
    exit
fi

inside
cycles="$2"
# Every actor below the stage, so leaks outside uiGroup's direct children count too.
count="$SHELL_ACTOR_COUNT"
t3="visor.content.registry.get('t3')"
connected() { shell_wait_for "$t3 != null && $t3.module.client.connected && $t3.rows.length > 0" 15; }

settle() { shell_eval 'new Promise(r => GLib.timeout_add(GLib.PRIORITY_LOW, 150, () => (r(true), false)))' >/dev/null; }

port="$(python3 -c 'import socket; s = socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1])')"
node "$repo/tests/mock/server.js" --port "$port" --home "$HOME/.t3" >/dev/null 2>&1 &
mock_pid=$!
trap 'kill "$mock_pid" 2>/dev/null || true' EXIT
t3_pair "http://127.0.0.1:$port" mock-token
connected
settle

# Visor builds its sheet a few seconds after it was enabled, or when the panel
# first opens. Opening it once makes both counts of a round include the sheet.
warm() {
    shell_eval 'visor.notch.open()' >/dev/null
    shell_wait_for 'visor.notch.state === "open"'
    shell_eval 'visor.notch.close()' >/dev/null
    shell_wait_for 'visor.notch.state !== "open"'
    settle
}

fail=0
# round NAME UUID: CYCLES times off and on.
round() {
    local state="Main.extensionManager.lookup('$2').state" i
    local actors_before signals_before actors_after signals_after grew log_before noise
    warm
    actors_before="$(shell_eval "$count")"
    signals_before="$(shell_eval 'visorSignalCounts()')"
    log_before="$(wc -l <"$HOME/shell.log")"
    for ((i = 1; i <= cycles; i++)); do
        shell_eval "Main.extensionManager.disableExtension('$2')" >/dev/null
        shell_wait_for "$state !== 1"
        shell_eval "Main.extensionManager.enableExtension('$2')" >/dev/null
        shell_wait_for "$state === 1"
        connected
    done
    warm
    actors_after="$(shell_eval "$count")"
    signals_after="$(shell_eval 'visorSignalCounts()')"
    grew="$(signals_grew "$signals_before" "$signals_after" "$cycles")"
    noise="$(tail -n "+$((log_before + 1))" "$HOME/shell.log" | grep -E 'JS ERROR|WARNING|CRITICAL|has been already disposed' || true)"
    echo "$1: $cycles cycles"
    echo "  actors before/after:   $actors_before / $actors_after"
    echo "  handlers before/after: $(signals_total "$signals_before") / $(signals_total "$signals_after")"
    echo "  shell warnings:        $(grep -c . <<<"$noise" || true)"
    [[ "$actors_before" == "$actors_after" ]] || { echo "FAIL: $1: actor count changed"; fail=1; }
    [[ -z "$grew" ]] || { echo "FAIL: $1: signal handlers left behind:"; echo "$grew"; fail=1; }
    [[ -z "$noise" ]] || { echo "FAIL: $1: shell warnings:"; echo "$noise" | head -n 20; fail=1; }
}
round 'the module off and on' "$uuid"
round 'Visor off and on' 'visor@taulit.github.io'
echo "mock: $(curl -s "http://127.0.0.1:$port/__mock/state")"
((fail == 0)) && echo "PASS"
exit "$fail"
