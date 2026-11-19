#!/usr/bin/env bash
# Takes the pictures of the catalog in the sandboxed headless shell of the
# Visor repository, against the mock server of tests/mock/ (invented sessions,
# no real T3 Code): the module alone in the panel, close up, on the wallpaper
# of Visor, 1600×1000, in the dark and the light scheme.
#
#   catalog/<uuid>/screenshot-<n>.png
#
# Usage: scripts/shots.sh
set -uo pipefail
cd "$(dirname "$0")/.."
source tests/shell/lib.sh

if [[ "${1:-}" == --inside ]]; then
    inside
    shell_wait_for 'visor !== null && visor.api !== null'
    shell_eval 'Main.overview.hide()' >/dev/null
    dconf write /org/gnome/shell/extensions/visor/disabled-modules "['upcoming', 'notifications']"
    port="$(python3 -c 'import socket; s = socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1])')"
    node "$repo/tests/mock/server.js" --port "$port" --home "$HOME/.t3" >>"$HOME/t3-mock.log" 2>&1 &
    trap 'kill $! 2>/dev/null' EXIT
    t3_pair "http://127.0.0.1:$port" mock-token
    rows="visor.content.registry.get('t3').rows"
    shell_wait_for "$rows.length >= 3 && $rows[0].detail !== undefined" 15
    shell_eval 'visor.notch.open()' >/dev/null
    shell_wait_for 'visor.notch.state === "open"'
    sleep 0.8
    shell_shot_focus "$2" visor-sheet 0 --frame
    exit 0
fi

fail=0
PATH="$repo/node_modules/.bin:$PATH" bash scripts/build.sh >/dev/null || { echo "FAIL  build"; exit 1; }
number=0
for scheme in dark light; do
    number=$((number + 1))
    file="$repo/catalog/$uuid/screenshot-$number.png"
    mkdir -p "$(dirname "$file")"
    if nested --scheme "$scheme" --size 6400x4000 --scale 4 \
        --log "$repo/.shell-test/shots.log" -- "$repo/scripts/shots.sh" --inside "$file" >/dev/null 2>&1; then
        echo "ok    ${file#"$repo"/}"
    else
        echo "FAIL  ${file#"$repo"/}: the scenario did not run"
        fail=1
    fi
done
exit "$fail"
