#!/usr/bin/env bash
# Pairing with T3 Code through the settings window, against the mock server of
# tests/mock/: a pairing link typed into the window and Connect store the
# token in the keyring (of the sandbox, see scripts/nested.sh) and nowhere
# else, the module in the shell connects without a restart and shows the
# sessions, Disconnect removes it, a token the server refuses is asked for
# once and not again, a bare code pairs anew, Connect next to "This machine"
# pairs through the command line of T3 Code (a stand-in below ~/.t3/bin), and
# a second server shows next to the first and is disconnected on its own. Then once more in a sandbox
# without a keyring: the window says so and keeps the code, the module logs
# one line, and connects once a keyring appears on the bus. And once with the keyring locked: the shell asks for its password
# before the code is spent, for as long as the user needs, a dismissed prompt
# keeps the code, and a window closed while the server answers still leaves
# the token in the keyring. The window is driven with the pointer and the keyboard, found
# through the accessibility bus.
#
# Usage: tests/shell/prefs.sh
# The log ends up in .shell-test/prefs.log, the output of the window in .shell-test/prefs.window.
set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
# Nothing of these may ever be written anywhere.
secrets='first-code-123|second-code-456|wrong-code-789|cli-code-321|mock-token|refused-token-abc'

if [[ "${1:-}" != --inside ]]; then
    mkdir -p "$repo/.shell-test"
    window="$repo/.shell-test/prefs.window"
    status=0
    nested --log "$repo/.shell-test/prefs.log" -- \
        "$repo/tests/shell/prefs.sh" --inside >"$window" 2>&1 || status=$?
    nested --no-keyring --log "$repo/.shell-test/prefs-no-keyring.log" -- \
        "$repo/tests/shell/prefs.sh" --inside no-keyring >>"$window" 2>&1 || status=$?
    nested --log "$repo/.shell-test/prefs-locked.log" -- \
        "$repo/tests/shell/prefs.sh" --inside locked >>"$window" 2>&1 || status=$?
    grep -v '^dbus-daemon\|^$' "$window" || true
    noise="$(grep -E '^\(org\.gnome\.Shell\.Extensions:|JS ERROR|Visor' "$window" |
        grep -v '^ok\|^FAIL\|atspi\|visible-page' || true)"
    if [[ -n "$noise" ]]; then
        echo "FAIL  the window process logged:"
        head -n 10 <<<"$noise"
        exit 1
    fi
    echo "ok    the window process logged no error"
    if grep -v '^ok\|^FAIL' "$window" | grep -qE "$secrets"; then
        echo "FAIL  a pairing code or the token is in the output of the window"
        exit 1
    fi
    echo "ok    no pairing code and no token in the output of the window"
    exit "$status"
fi

inside
source "$visor_repo/scripts/lib/prefs.sh"
# The window of this module, not the one of Visor.
PREFS_WINDOW='Visor: T3 Code'
prefs_open() {
    gdbus call --session --dest org.gnome.Shell --object-path /org/gnome/Shell \
        --method org.gnome.Shell.Extensions.OpenExtensionPrefs "$uuid" '' '{}' >/dev/null
    shell_wait_for "global.get_window_actors().some(a => a.meta_window.title === '$PREFS_WINDOW')" 20
    sleep 1
    # The first click after the window opens is lost; this one hits the margin of the page.
    prefs_click 20 400
}
failures=0
log_start="$(wc -l <"$HOME/shell.log")"
# check NAME JS: passes when JS evaluates to true.
check() {
    local got
    got="$(shell_eval "$2" 2>&1)" || true
    if [[ "$got" == true ]]; then echo "ok    $1"; else echo "FAIL  $1: $got"; failures=$((failures + 1)); fi
}
expect_setting() {
    local got
    got="$(gg "$2")"
    if [[ "$got" == "$3" ]]; then echo "ok    $1"; else echo "FAIL  $1: expected $3, got $got"; failures=$((failures + 1)); fi
}
# wait_check NAME JS [seconds]: like check, but gives JS time to become true.
wait_check() {
    if shell_wait_for "$2" "${3:-8}" 2>/dev/null; then
        echo "ok    $1"
    else
        echo "FAIL  $1: $(shell_eval "$2" 2>&1 || true)"
        failures=$((failures + 1))
    fi
}

port="$(python3 -c 'import socket; s = socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1])')"
node "$repo/tests/mock/server.js" --port "$port" --home "$HOME/.t3" --pairing first-code-123 >>"$HOME/t3-mock.log" 2>&1 &
mock_pid=$!
trap 'kill "$mock_pid" 2>/dev/null || true' EXIT
# A stand-in for the command line of T3 Code, where T3 Code installs it: it
# notes how it was called and makes a pairing code of the mock.
mkdir -p "$HOME/.t3/bin"
cat >"$HOME/.t3/bin/t3" <<CLI
#!/bin/sh
printf '%s\n' "\$*" >>"$HOME/t3-cli.args"
curl -s -X POST 'http://127.0.0.1:$port/__mock/pairing?code=cli-code-321' >/dev/null
printf '{"id":"p-1","credential":"cli-code-321","label":"Visor","scopes":[],"expiresAt":"2030-01-01T00:00:00.000Z"}\n'
CLI
chmod +x "$HOME/.t3/bin/t3"
# mock_state PYTHON: an expression over the state `s` of the mock, printed as true or false.
mock_state() { curl -s "http://127.0.0.1:$port/__mock/state" | python3 -c "import json,sys; s=json.load(sys.stdin); print(str($1).lower())"; }
# wait_mock PYTHON [seconds]: gives the expression time to become true.
wait_mock() {
    local i
    for ((i = 0; i < ${2:-5} * 5; i++)); do
        [[ "$(mock_state "$1")" == true ]] && return 0
        sleep 0.2
    done
    return 0
}
expect_mock() {
    local got
    got="$(mock_state "$2")"
    if [[ "$got" == true ]]; then echo "ok    $1"; else echo "FAIL  $1: $(curl -s "http://127.0.0.1:$port/__mock/state")"; failures=$((failures + 1)); fi
}

# expect_keyring NAME ORIGIN TOKEN: what the keyring of the sandbox holds for ORIGIN.
expect_keyring() {
    local got tries
    # The window stores and clears asynchronously: wait for it, up to 10 s.
    for tries in $(seq 50); do
        got="$(keyring_lookup "$2")"
        [[ "$got" == "$3" ]] && break
        sleep 0.2
    done
    if [[ "$got" == "$3" ]]; then echo "ok    $1"; else echo "FAIL  $1: the keyring has ${got:+another token}${got:-nothing}"; failures=$((failures + 1)); fi
}
# The settings as dconf has them, as text and as the file on disk.
expect_no_secret_in_dconf() {
    if dconf dump / | grep -qE "$secrets" || grep -qaE "$secrets" "$XDG_CONFIG_HOME/dconf/user"; then
        echo "FAIL  $1"; failures=$((failures + 1))
    else
        echo "ok    $1"
    fi
}
# expect_shows NAME TEXT: the window shows exactly that text somewhere.
expect_shows() {
    if prefs_shows "$2"; then echo "ok    $1"; else echo "FAIL  $1: the window does not show '$2'"; failures=$((failures + 1)); fi
}
origin="http://127.0.0.1:$port"
serial() { gg token-serial; }
# pair_by_hand TOKEN: what pairing leaves behind, without the window.
pair_by_hand() { t3_pair "$origin" "$1"; }

t3="visor.content.registry.get('t3')"
client="$first_client"
check 'not paired: no rows, no client' "$t3.rows.length === 0 && $t3.module.clients.size === 0"

if [[ "${2:-}" == no-keyring ]]; then
    # --- no Secret Service on the bus ------------------------------------------------
    owner="$(gdbus call --session --dest org.freedesktop.DBus --object-path /org/freedesktop/DBus --method org.freedesktop.DBus.NameHasOwner org.freedesktop.secrets)"
    if [[ "$owner" == '(false,)' ]]; then echo 'ok    this sandbox has no keyring'; else echo "FAIL  this sandbox has a keyring: $owner"; failures=$((failures + 1)); fi
    prefs_a11y
    prefs_open
    prefs_click_on 'Pairing link or code' 'password text'
    prefs_type "$origin/pair#token=first-code-123"
    prefs_click_on Connect button
    sleep 1
    expect_shows 'without a keyring the row says so' 'The keyring is not available'
    expect_mock 'and the pairing code was not used up' "s['exchanges'] == 0 and s['pairings'] == []"
    expect_setting 'nothing is paired' servers '@as []'
    check 'the window is still there' "global.get_window_actors().some(a => a.meta_window.title === '$PREFS_WINDOW')"
    prefs_close

    # Paired before the keyring went away: the module has no token.
    gs token-serial 1
    gs servers "['$origin']"
    sleep 2
    check 'the module shows nothing and waits for nothing' \
        "$t3.rows.length === 0 && !$client?.connected && !$client.connecting && $client.retrySource === 0 && $client.lookup === null"
    shell_eval "visor.content.registry.setEnabled('t3', false)" >/dev/null
    shell_eval "visor.content.registry.setEnabled('t3', true)" >/dev/null
    sleep 1
    lines="$(tail -n "+$((log_start + 1))" "$HOME/shell.log" | grep -c 'The keyring is not available' || true)"
    if [[ "$lines" == 1 ]]; then echo 'ok    one line in the log says so, also after the module was turned off and on'; else echo "FAIL  $lines lines in the log about the keyring"; failures=$((failures + 1)); fi
    expect_mock 'the server was not asked for anything' "s['ticketRequests'] == 0"

    # The keyring starts later (a session that brings it up after the shell):
    # the module reads the token without being paired anew.
    keyring_start
    keyring_store "$origin" mock-token
    kill "$keyring_pid"
    shell_wait_for "$client.keyringOwned === false"
    check 'no keyring again: still nothing' "$t3.rows.length === 0 && !$client?.connected"
    keyring_start
    wait_check 'the keyring appears: the module reads the token and connects' \
        "$client?.connected && $t3.rows.length === 4"
    check 'Visor and the module are still enabled' "Main.extensionManager.lookup('$uuid').state === 1 && Main.extensionManager.lookup('visor@taulit.github.io').state === 1"
    noise="$(tail -n "+$((log_start + 1))" "$HOME/shell.log" | grep -E 'JS ERROR|WARNING|CRITICAL|visor' | grep -v 'Tried to ping window' || true)"
    if [[ -z "$noise" ]]; then echo 'ok    the shell logged nothing else'; else echo 'FAIL  the shell logged:'; head -n 20 <<<"$noise"; failures=$((failures + 1)); fi
    ((failures == 0)) && echo PASS
    exit "$((failures > 0))"
fi

if [[ "${2:-}" == locked ]]; then
    # --- the keyring is locked --------------------------------------------------------
    # The prompt of the keyring is a dialog of the shell; the test answers it there.
    dialog="Main.layoutManager.modalDialogGroup.get_children().find(d => d.constructor.name === 'KeyringDialog' && d.state === 0)"
    keyring_lock
    prefs_a11y
    prefs_open
    prefs_click_on 'Pairing link or code' 'password text'
    prefs_type "$origin/pair#token=first-code-123"
    prefs_click_on Connect button
    wait_check 'a locked keyring: the shell asks for its password' "$dialog != null"
    sleep 11
    check 'and still does after more than ten seconds' "$dialog != null"
    expect_mock 'the pairing code is not used meanwhile' "s['exchanges'] == 0"
    shell_eval "(() => { const d = $dialog; d._passwordEntry.text = 'sandbox'; d._onContinueButton(); return true; })()" >/dev/null
    expect_keyring 'with the password the token is stored' "$origin" mock-token
    expect_setting 'and its origin' servers "['$origin']"
    expect_mock 'after one exchange' "s['exchanges'] == 1 and len(s['pairings']) == 1"
    expect_keyring 'the probe item is gone' visor:probe ''
    wait_check 'the module connects' "$client?.connected && $t3.rows.length === 4"
    expect_shows 'the window lists the server' "This machine · $origin"

    # The prompt dismissed: the code is kept.
    prefs_click_on Disconnect button
    expect_keyring 'Disconnect removes the token' "$origin" ''
    curl -s -X POST "http://127.0.0.1:$port/__mock/pairing?code=second-code-456" >/dev/null
    keyring_lock
    prefs_click_on 'Pairing link or code' 'password text'
    prefs_type 'second-code-456'
    prefs_click_on Connect button
    wait_check 'locked again: the shell asks again' "$dialog != null"
    shell_eval "(() => { $dialog._onCancelButton(); return true; })()" >/dev/null
    sleep 1
    expect_shows 'the prompt dismissed: the row says so' 'The keyring is not available'
    expect_mock 'and the pairing code was not used up' "s['exchanges'] == 1"
    expect_setting 'nothing is paired' servers '@as []'

    # The window closes while the server answers: the token is kept all the same.
    curl -s -X POST "http://127.0.0.1:$port/__mock/slow-token?ms=1000" >/dev/null
    prefs_click_on 'The keyring is not available' 'password text'
    prefs_type 'second-code-456'
    prefs_click_on Connect button
    wait_check 'the shell asks once more' "$dialog != null"
    shell_eval "(() => { const d = $dialog; d._passwordEntry.text = 'sandbox'; d._onContinueButton(); return true; })()" >/dev/null
    wait_mock "s['exchanges'] == 2"
    prefs_close
    expect_mock 'the window closed while the server was answering' "s['exchanges'] == 2 and len(s['pairings']) == 2"
    expect_keyring 'the token is in the keyring all the same' "$origin" mock-token
    expect_setting 'with its origin' servers "['$origin']"
    wait_check 'and the module connects' "$client?.connected && $t3.rows.length === 4"
    expect_no_secret_in_dconf 'no pairing code and no token in dconf'
    noise="$(tail -n "+$((log_start + 1))" "$HOME/shell.log" | grep -E 'JS ERROR|WARNING|CRITICAL|visor' | grep -v 'Tried to ping window' || true)"
    if [[ -z "$noise" ]]; then echo 'ok    the shell logged nothing else'; else echo 'FAIL  the shell logged:'; head -n 20 <<<"$noise"; failures=$((failures + 1)); fi
    ((failures == 0)) && echo PASS
    exit "$((failures > 0))"
fi

prefs_a11y
prefs_open
field() { prefs_click_on "${1:-Pairing link or code}" 'password text'; }

# --- a link the server does not know ---------------------------------------------
field
prefs_type "http://127.0.0.1:$port/pair#token=wrong-code-789"
prefs_enter
wait_mock "s['exchanges'] == 1"
expect_mock 'the server refuses a wrong pairing link' "s['exchanges'] == 1 and s['pairings'] == [] and s['ticketRequests'] == 0"
expect_keyring 'and no token is stored' "$origin" ''
expect_setting 'nothing is paired' servers '@as []'
expect_shows 'the row says that the link is wrong' 'The link is wrong or has expired'

# --- pairing -------------------------------------------------------------------
field 'The link is wrong or has expired'
prefs_type "http://127.0.0.1:$port/pair#token=first-code-123"
prefs_click_on Connect button
expect_keyring 'Connect with the pairing link stores the token in the keyring' "$origin" mock-token
expect_no_secret_in_dconf 'and not in dconf'
expect_setting 'the settings count the change' token-serial 1
expect_shows 'the window lists the server' "This machine · $origin"
expect_setting 'the list of servers has the origin the token is for' servers "['$origin']"
expect_mock 'the server saw one exchange, labelled Visor, for both scopes' \
    "len(s['pairings']) == 1 and s['pairings'][0]['label'].startswith('Visor (') and s['pairings'][0]['scope'] == 'orchestration:read orchestration:operate'"
wait_check 'the module connects without a restart and shows the sessions' \
    "$client?.connected && $t3.rows.length === 4"

# --- disconnect ----------------------------------------------------------------
prefs_click_on Disconnect button
expect_keyring 'Disconnect removes the token from the keyring' "$origin" ''
expect_setting 'and forgets its origin' servers '@as []'
wait_check 'the rows are gone and the client with them' "$t3.rows.length === 0 && $t3.module.clients.size === 0"
sleep 0.5
expect_mock 'the server sees no client' "s['clients'] == 0"

# --- a token the server refuses ------------------------------------------------
before="$(curl -s "http://127.0.0.1:$port/__mock/state" | python3 -c 'import json,sys; print(json.load(sys.stdin)["ticketRequests"])')"
pair_by_hand refused-token-abc
sleep 5
expect_mock 'a refused token is tried once in five seconds' "s['ticketRequests'] == $before + 1"
check 'the module waits for another token' \
    "$client.rejected && $client.retrySource === 0 && !$client.connecting && $t3.rows.length === 0"
refused="$(tail -n "+$((log_start + 1))" "$HOME/shell.log" | grep -c 'refused the access token' || true)"
if [[ "$refused" == 1 ]]; then echo 'ok    one line in the log says so'; else echo "FAIL  $refused lines in the log about the refused token"; failures=$((failures + 1)); fi

# --- pairing again, with the code alone ------------------------------------------
curl -s -X POST "http://127.0.0.1:$port/__mock/pairing?code=second-code-456" >/dev/null
prefs_click_on Disconnect button
expect_keyring 'Disconnect forgets the refused token' "$origin" ''
field
prefs_type '  second-code-456 '
prefs_enter
sleep 1
expect_keyring 'a bare code and Enter pair with the server of this machine' "$origin" mock-token
wait_check 'the module connects again' "$client?.connected && $t3.rows.length === 4"

# --- this machine, through the command line of T3 Code ---------------------------
prefs_click_on Disconnect button
expect_keyring 'Disconnect once more' "$origin" ''
expect_shows 'not paired with the local server: the window offers to pair it' 'Pair with the T3 Code server running here, without a link'
prefs_click_on 'This machine'
expect_keyring 'Connect next to "This machine" pairs through the command line' "$origin" mock-token
expect_setting 'with the local server' servers "['$origin']"
if grep -qxF -- 'auth pairing create --json --ttl 2m --scope orchestration:read --scope orchestration:operate --label Visor ('"$(hostname)"')' "$HOME/t3-cli.args" 2>/dev/null; then
    echo 'ok    the command line was asked for a short-lived code with the two scopes, once'
else
    echo "FAIL  the command line was asked: $(cat "$HOME/t3-cli.args" 2>/dev/null)"; failures=$((failures + 1))
fi
wait_check 'the module connects' "$client?.connected && $t3.rows.length === 4"
if prefs_shows 'Pair with the T3 Code server running here, without a link'; then
    echo 'FAIL  the window still offers to pair the local server'; failures=$((failures + 1))
else
    echo 'ok    paired: the window offers it no more'
fi

# --- a second server ----------------------------------------------------------------
port2="$(python3 -c 'import socket; s = socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1])')"
node "$repo/tests/mock/server.js" --port "$port2" --pairing second-machine-code \
    --environment env-other --label other >>"$HOME/t3-mock-2.log" 2>&1 &
mock2_pid=$!
trap 'kill "$mock_pid" "$mock2_pid" 2>/dev/null || true' EXIT
for _ in $(seq 50); do curl -s -o /dev/null "http://127.0.0.1:$port2/.well-known/t3/environment" && break; sleep 0.1; done
field
prefs_type "http://127.0.0.1:$port2/pair#token=second-machine-code"
prefs_click_on Connect button
expect_keyring 'a pairing link of a second server stores its token too' "http://127.0.0.1:$port2" mock-token
expect_keyring 'next to the first' "$origin" mock-token
expect_setting 'the list has both, in the order they were paired' servers "['$origin', 'http://127.0.0.1:$port2']"
sleep 1
expect_shows 'the window names the second server as it calls itself' 'other'
wait_check 'the module shows the sessions of both' \
    "$t3.module.clients.size === 2 && [...$t3.module.clients.values()].every(c => c.connected) && $t3.module.sessions.length === 8"
prefs_click_on Disconnect button
expect_keyring 'Disconnect of the first row removes its token' "$origin" ''
expect_keyring 'and leaves the token of the second' "http://127.0.0.1:$port2" mock-token
expect_setting 'and the second server' servers "['http://127.0.0.1:$port2']"
wait_check 'the module keeps the second' "$t3.module.clients.size === 1 && $client?.connected && $client.origin === 'http://127.0.0.1:$port2'"

# --- a token goes to its own server only -------------------------------------------
before="$(curl -s "http://127.0.0.1:$port/__mock/state" | python3 -c 'import json,sys; print(json.load(sys.stdin)["ticketRequests"])')"
gs servers "['http://127.0.0.1:$port2', 'http://127.0.0.1:1']"
sleep 2.5
expect_mock 'a server without a token is offered none, and no other' "s['ticketRequests'] == $before"
kill "$mock2_pid" 2>/dev/null || true

prefs_close
expect_no_secret_in_dconf 'no pairing code and no token in dconf'
if grep -qE "$secrets" "$HOME/keyring.log" "$HOME/a11y-registry.log" 2>/dev/null; then
    echo 'FAIL  a pairing code or the token is in the log of the keyring'; failures=$((failures + 1))
fi
if tail -n "+$((log_start + 1))" "$HOME/shell.log" | grep -qE "$secrets"; then
    echo 'FAIL  a pairing code or the token is in the log of the shell'; failures=$((failures + 1))
else
    echo 'ok    no pairing code and no token in the log of the shell'
fi
noise="$(tail -n "+$((log_start + 1))" "$HOME/shell.log" | grep -E 'JS ERROR|WARNING|CRITICAL|visor' | grep -v 'Tried to ping window' || true)"
if [[ -z "$noise" ]]; then echo 'ok    the shell logged nothing else'; else echo 'FAIL  the shell logged:'; head -n 20 <<<"$noise"; failures=$((failures + 1)); fi
((failures == 0)) && echo PASS
exit "$((failures > 0))"
