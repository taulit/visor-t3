#!/usr/bin/env bash
# Drives the T3 Code module in the sandboxed headless shell against the mock
# server of tests/mock/: an agent waits, the dot turns amber, the island
# flashes, Allow reaches the server and the row runs again; then Deny, a
# reply, Stop, the expanded row, a finished session, "+ n more", a server
# that goes and comes back, and the command `t3`. And what must not have an
# Allow button: a command that is cut, one with invisible characters, one the
# server does not tell, and a click meant for the request before.
#
# The two minutes a finished session keeps its row are shortened by the mock:
# it reports a run that ended 117 seconds ago.
#
# Usage: tests/shell/t3.sh
# The log ends up in .shell-test/t3.log.
set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

if [[ "${1:-}" != --inside ]]; then
    nested --log "$repo/.shell-test/t3.log" -- "$repo/tests/shell/t3.sh" --inside
    exit
fi

inside

fail=0
# check NAME JS: passes when JS evaluates to true.
check() {
    local got
    got="$(shell_eval "$2" 2>&1)" || true
    if [[ "$got" == true ]]; then
        echo "ok    $1"
    else
        echo "FAIL  $1: $got"
        fail=1
    fi
}
# wait_check NAME JS [seconds]: like check, but gives JS time to become true.
wait_check() {
    if shell_wait_for "$2" "${3:-5}" 2>/dev/null; then
        echo "ok    $1"
    else
        echo "FAIL  $1: $(shell_eval "$2" 2>&1 || true)"
        fail=1
    fi
}
run() { shell_eval "$1" >/dev/null; }

shell_wait_for 'visor !== null && visor.api !== null'
run 'Main.overview.hide()'
shell_wait_for '!Main.overview.visible'
log_before="$(wc -l <"$HOME/shell.log")"

port="$(python3 -c 'import socket; s = socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1])')"
mock_pid=
start_mock() {
    node "$repo/tests/mock/server.js" --port "$port" --home "$HOME/.t3" "$@" >>"$HOME/t3-mock.log" 2>&1 &
    mock_pid=$!
}
stop_mock() { kill "$mock_pid" 2>/dev/null || true; wait "$mock_pid" 2>/dev/null || true; }
trap stop_mock EXIT
# mock PATH [curl options]: a test control of the mock.
mock() { curl -s -X POST "http://127.0.0.1:$port/__mock/$1" "${@:2}" >/dev/null; }
# actions JQ-like python expression over the list `a` of recorded commands.
actions() { curl -s "http://127.0.0.1:$port/__mock/actions" | python3 -c "import json,sys; a=json.load(sys.stdin); print(str($1).lower())"; }
mock_state() { curl -s "http://127.0.0.1:$port/__mock/state" | python3 -c "import json,sys; s=json.load(sys.stdin); print(str($1).lower())"; }

run "(() => {
    const keyboard = Clutter.get_default_backend().get_default_seat().create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);
    const press = symbol => {
        keyboard.notify_keyval(GLib.get_monotonic_time(), symbol, Clutter.KeyState.PRESSED);
        keyboard.notify_keyval(GLib.get_monotonic_time(), symbol, Clutter.KeyState.RELEASED);
    };
    const wait = ms => new Promise(r => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => (r(true), false)));
    const up = (actor, cls) => {
        while (actor && !actor.has_style_class_name(cls)) actor = actor.get_parent();
        return actor ?? null;
    };
    const entry = () => visor.content.registry.get('t3');
    globalThis.A = {
        wait,
        find: cls => $(content_find "' + cls + '"),
        mod: () => entry().module,
        rows: () => entry().rows,
        row: id => entry().rows.find(r => r.id === 't3:' + id),
        ids: () => entry().rows.map(r => r.id.slice(3)).join(),
        chip: () => entry().chip,
        action: (row, label) => [...(row.controls ?? []), row.primary].find(a => a && a.label === label),
        // The row with this title as it is on screen.
        chevron: title => A.find('visor-row-chevron').find(c => A.actor(title).contains(c)),
        // Deny and Allow below the full command of an expanded row.
        answers: () => A.find('visor-t3-buttons').filter(a => a.mapped && a.get_children().length === 2 && a.get_first_child().label_actor.text === 'Deny').flatMap(a => a.get_children()),
        actor: title => up(A.find('visor-row-title').find(a => a.mapped && a.text === title), 'visor-row'),
        async type(text) {
            for (const char of text) {
                press(Clutter.unicode_to_keysym(char.codePointAt(0)));
                await wait(15);
            }
            await wait(300);
        },
        async enter() {
            press(Clutter.KEY_Return);
            await wait(200);
        },
        results: () => A.find('visor-result-title').filter(a => a.mapped).map(a => a.text),
        dot: () => A.find('visor-dot')[0] ?? Main.panel._centerBox.get_first_child().get_first_child().get_last_child(),
    };
    return true;
})()"
wait_title='Spawn a subagent for the fixture'

# --- not paired, no server ---------------------------------------------------

check 'without a token the module is empty and waits for nothing' \
    "A.rows().length === 0 && A.chip() === null && A.mod().client.retrySource === 0 && !A.mod().client.connecting"
t3_pair "http://127.0.0.1:$port" mock-token
run 'A.wait(1500)'
check 'without a server the module is empty' "A.rows().length === 0 && !A.mod().client.connected"
check 'and it tries again later' "A.mod().client.retrySource !== 0"

# --- scenario 3: an agent waits, the user allows ---------------------------------

start_mock
wait_check 'the server appears: connected' "A.mod().client.connected" 8
wait_check 'four sessions: waiting first, three rows and "+ 1 more"' \
    "A.ids() === 'thread-wait,thread-run,thread-done,more' && A.row('more').title === '+ 1 more'"
check 'the waiting row is amber and names the project' \
    "A.row('thread-wait').status === 'waiting' && A.row('thread-wait').title === '$wait_title' && A.row('thread-wait').subtitle === 'visor · Wants to run'"
wait_check 'it shows the command the subagent asks about' \
    "A.row('thread-wait').detail === \"printf 'subagent approval fixture' > subagent-approval.txt\""
check 'a command the one line cuts off cannot be allowed from the collapsed row' \
    "A.row('thread-wait').controls === undefined && A.row('thread-wait').primary === undefined"
check 'the dot next to the clock is amber' \
    "visor.content.attention === 'waiting' && A.dot().visible && A.dot().has_style_class_name('waiting')"
check 'the chip: amber, most important' \
    "A.chip().text === 'Spawn a subagent fo… is waiting' && A.chip().tone === 'waiting' && A.chip().priority === 100"
check 'the island flashes with the amber chip' \
    "visor.notch.state === 'peek' && visor.content.getPeek().get_child_at_index(0).label_actor.text === A.chip().text && visor.content.getPeek().get_child_at_index(0).has_style_class_name('waiting')"
check 'the running row counts the time only with the panel open' \
    "/^visor · Working · 4:[0-9][0-9]$/.test(A.row('thread-run').subtitle) && A.mod().tickSource === 0"
check 'the done row has a check' "A.row('thread-done').status === 'done' && A.row('thread-done').icon === 'object-select-symbolic' && A.row('thread-done').subtitle === 'visor · Done'"

run 'visor.notch.open()'
shell_wait_for 'visor.notch.state === "open"'
check 'the expanded waiting row shows the complete command' \
    "(async () => { A.chevron('$wait_title').emit('clicked', 1); await A.wait(300); const label = A.find('visor-t3-command').find(a => a.mapped); return label != null && label.text === \"printf 'subagent approval fixture' > subagent-approval.txt\" && !label.clutter_text.get_layout().is_ellipsized() && !A.find('visor-t3-cut').some(a => a.mapped) || (label ? label.text : 'no label'); })()"
check 'with Deny and Allow below it' \
    "A.answers().map(b => b.label_actor.text).join() === 'Deny,Allow'"
# A request that has just come in ignores Allow and Deny for 500 ms (ANSWER_GUARD_MS).
sleep 0.6
run "A.answers()[1].emit('clicked', 1)"
check 'Allow: the row runs at once' "A.row('thread-wait').status === undefined && A.row('thread-wait').primary === undefined && A.row('thread-wait').subtitle.startsWith('visor · Working')"
wait_check 'the dot and the chip are gone' "visor.content.attention === null && A.chip() === null && !A.dot().visible"
sleep 0.5
check 'the mock received the approval for the subagent thread' \
    "$(actions "len(a) == 1 and a[0]['type'] == 'runtime-request.respond' and a[0]['decision'] == 'accept' and a[0]['threadId'] == 'thread-wait-child' and a[0]['requestId'] == 'request-1'")"
check 'the command and its buttons are gone from the expanded row' \
    "!A.find('visor-t3-command').some(a => a.mapped) && A.answers().length === 0"
run "A.chevron('$wait_title').emit('clicked', 1)"
wait_check 'the server confirms: the row shows running' \
    "A.row('thread-wait').subtitle.startsWith('visor · Working') && A.mod().answered.size === 0 && A.mod().client.shell.threads.get('thread-wait-child').request === null"

# --- deny, and an action that fails ------------------------------------------

run 'visor.notch.open()'
shell_wait_for 'visor.notch.state === "open"'
mock 'wait?thread=thread-run&request=request-2&prompt=rm%20-rf%20build'
wait_check 'a second approval: the row waits, on top' "A.ids().startsWith('thread-run,') && A.row('thread-run').detail === 'rm -rf build'"
check 'a short command is answered in the row: Deny is a ghost button, Allow the primary one' \
    "A.row('thread-run').controls.map(a => a.label + ':' + a.style).join() === 'Deny:ghost' && A.row('thread-run').primary.label === 'Allow' && A.row('thread-run').primary.style === 'primary'"
sleep 0.6
check 'no flash while the panel is open, but the dot' "visor.notch.state === 'open' && visor.content.attention === 'waiting'"
mock fail-next
run "A.action(A.row('thread-run'), 'Deny').run()"
wait_check 'a failed Deny comes back with the reason in the subtitle' \
    "A.row('thread-run').status === 'waiting' && A.row('thread-run').subtitle === 'visor · Could not send · The mock was told to fail this command.'"
run "A.action(A.row('thread-run'), 'Deny').run()"
wait_check 'Deny: the row runs again' "A.row('thread-run').status === undefined && A.row('thread-run').subtitle.startsWith('visor · Working')"
sleep 0.3
check 'the mock received the denial' "$(actions "a[-1]['type'] == 'runtime-request.respond' and a[-1]['decision'] == 'decline' and a[-1]['threadId'] == 'thread-run' and a[-1]['requestId'] == 'request-2'")"

# --- the open panel: time, expand, reply, stop --------------------------------

check 'the time ticks while the panel is open' "A.mod().tickSource !== 0"
check 'and moves' "(async () => { const before = A.row('thread-wait').subtitle; await A.wait(2100); return A.row('thread-wait').subtitle !== before; })()"
check 'expanding shows the last message of the agent, as plain text' \
    "(async () => { A.chevron('$wait_title').emit('clicked', 1); await A.wait(200); const label = A.find('visor-t3-message').find(a => a.mapped); return label !== undefined && label.text === 'I asked a subagent to write the fixture file. It needs your approval to run the command.' && !label.clutter_text.use_markup; })()"
check 'with a reply field and the buttons Stop and Open in T3 Code' \
    "A.find('visor-t3-reply').filter(a => a.mapped).length === 1 && A.find('visor-t3-buttons').find(a => a.mapped).get_children().map(b => b.label_actor.text).join() === 'Stop,Open in T3 Code'"
check 'typing a reply and Enter sends it' \
    "(async () => { const entry = A.find('visor-t3-reply').find(a => a.mapped); entry.grab_key_focus(); await A.type('go on'); const typed = entry.get_text(); await A.enter(); return typed === 'go on' && entry.get_text() === '' && visor.notch.state === 'open' || [typed, entry.get_text(), visor.notch.state].join(' # '); })()"
sleep 0.3
check 'the mock received the reply' "$(actions "a[-1]['type'] == 'message.dispatch' and a[-1]['text'] == 'go on' and a[-1]['threadId'] == 'thread-wait' and a[-1]['createdBy'] == 'user'")"
check 'Stop: the row is gone at once' \
    "(async () => { A.find('visor-t3-buttons').find(a => a.mapped).get_first_child().emit('clicked', 1); await A.wait(100); return A.row('thread-wait') === undefined; })()"
sleep 0.3
check 'the mock received the stop' "$(actions "a[-1]['type'] == 'thread.stop' and a[-1]['threadId'] == 'thread-wait'")"
wait_check 'the server confirms: three sessions, no "more" row' "A.ids() === 'thread-run,thread-done,thread-error' && A.mod().stopped.size === 0"
check 'a failed session says why' "A.row('thread-error').subtitle === 'visor · Failed · The provider process exited with code 1.' && A.row('thread-error').icon === 'dialog-warning-symbolic'"

# --- a command of many lines ---------------------------------------------------

long_command="$(printf 'echo step-%s && ' $(seq 1 60))true"
mock "wait?thread=thread-run&request=request-3&prompt=$(python3 -c 'import sys, urllib.parse; print(urllib.parse.quote(sys.argv[1]))' "$long_command")"
wait_check 'a very long command: one line in the row, no Allow there' \
    "A.row('thread-run').status === 'waiting' && A.row('thread-run').detail?.endsWith('…') && A.row('thread-run').primary === undefined"
check 'expanded it is complete in the label, cut after eight lines on screen, with the hint' \
    "(async () => { A.chevron(A.row('thread-run').title).emit('clicked', 1); await A.wait(400); const label = A.find('visor-t3-command').find(a => a.mapped); const hint = A.find('visor-t3-cut').find(a => a.mapped); const lines = label ? label.clutter_text.get_layout().get_line_count() : 0; return label != null && label.text === '$long_command' && label.clutter_text.get_layout().is_ellipsized() && lines === 8 && hint?.text === 'Open T3 Code to read all of it' || (label ? lines + ' lines, hint ' + (hint != null) : 'no label'); })()"
check 'a command that is cut has no Deny and no Allow, only the way to T3 Code' \
    "A.answers().length === 0 && A.row('thread-run').controls === undefined && A.find('visor-t3-buttons').find(a => a.mapped).get_children().map(b => b.label_actor.text).join() === 'Stop,Open in T3 Code'"

# quote TEXT: for the query of a mock control.
quote() { python3 -c 'import sys, urllib.parse; print(urllib.parse.quote(sys.argv[1]))' "$1"; }
# The command label and the hint of the expanded row, as they are on screen.
label="A.find('visor-t3-command').find(a => a.mapped)"
hint="A.find('visor-t3-cut').find(a => a.mapped)"

# --- what must not be allowed from Visor -----------------------------------------

mock "wait?thread=thread-run&request=request-4&prompt=$(quote $'l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8')"
wait_check 'eight short lines are on screen whole: Deny and Allow below them' \
    "$label?.text.split(String.fromCharCode(10)).length === 8 && !$label.clutter_text.get_layout().is_ellipsized() && $hint === undefined && A.answers().map(b => b.label_actor.text).join() === 'Deny,Allow'"
check 'but not in the row, which shows one line' "A.row('thread-run').primary === undefined && A.row('thread-run').controls === undefined"
mock "wait?thread=thread-run&request=request-5&prompt=$(quote $'l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\nrm -rf ~')"
wait_check 'nine lines: the ninth is not on screen' "$label?.text.endsWith('l8…') && $label.text.split(String.fromCharCode(10)).length === 8 && A.row('thread-run').detail.endsWith('rm -rf ~')"
run 'A.wait(300)'
check 'so there is no Allow, in the row or below the command, and the hint says where to read it' \
    "A.answers().length === 0 && !A.find('visor-t3-buttons').some(a => a.mapped && a.get_children().some(b => b.label_actor.text === 'Allow')) && A.row('thread-run').primary === undefined && $hint?.text === 'Open T3 Code to read all of it'"

mock "wait?thread=thread-run&request=request-6&prompt=$(quote $'ls ‮-la')"
wait_check 'a command with a bidi override shows it as U+FFFD' \
    "A.row('thread-run').detail === 'ls �-la' && $label?.text === 'ls �-la'"
run 'A.wait(300)'
check 'and has no Allow, however short it is' \
    "A.answers().length === 0 && A.row('thread-run').primary === undefined && A.row('thread-run').controls === undefined && $hint?.text === 'Has characters that cannot be shown. Open T3 Code to read it'"

mock 'wait?thread=thread-run&request=request-7&prompt=ls&projection=fail'
wait_check 'a command the server does not tell is asked for three times, then no more' \
    "A.mod().failures.get('request-7')?.count === 3 && A.mod().failures.get('request-7').retryAt === null && !A.mod().asking.has('request-7')" 8
check 'the mock was asked three times' "$(mock_state "s['projections'] >= 7")"
check 'the row has no Allow and no Deny, it sends the user to T3 Code' \
    "A.row('thread-run').status === 'waiting' && A.row('thread-run').subtitle === 'visor · Answer this request in T3 Code' && A.row('thread-run').detail === undefined && A.row('thread-run').controls === undefined && A.row('thread-run').primary.label === 'Open in T3 Code'"
check 'and nothing to allow in the expanded row' \
    "A.answers().length === 0 && $label === undefined && !A.find('visor-t3-buttons').some(a => a.mapped && a.get_children().some(b => b.label_actor.text === 'Allow'))"
before="$(curl -s "http://127.0.0.1:$port/__mock/state" | python3 -c 'import json,sys; print(json.load(sys.stdin)["projections"])')"
run 'A.wait(2500)'
check 'it is not asked for again' "$(mock_state "s['projections'] == $before")"

# --- a click meant for the request before ----------------------------------------

mock 'wait?thread=thread-run&request=request-8&prompt=rm%20-rf%20a'
wait_check 'a short command again: Allow in the row' "A.row('thread-run').detail === 'rm -rf a' && A.row('thread-run').primary?.label === 'Allow'"
run "globalThis.oldAllow = A.action(A.row('thread-run'), 'Allow')"
mock reset
(sleep 0.4; mock 'wait?thread=thread-run&request=request-9&prompt=rm%20-rf%20b') &
late=$!
check 'another request takes its place: a click right then does nothing' \
    "(async () => { for (let i = 0; i < 150 && A.row('thread-run').detail !== 'rm -rf b'; i++) await A.wait(20); A.action(A.row('thread-run'), 'Allow').run(); oldAllow.run(); await A.wait(300); return A.row('thread-run').detail === 'rm -rf b' && A.row('thread-run').status === 'waiting' && A.mod().answered.size === 0; })()"
wait "$late"
run 'A.wait(400)'
run 'oldAllow.run()'
sleep 0.3
check 'and the button of the old request stays dead: the mock received nothing' \
    "$(actions "len(a) == 0") && A.row('thread-run').status === 'waiting'"
run "A.action(A.row('thread-run'), 'Deny').run()"
wait_check 'Deny of the new request: the row runs again' "A.row('thread-run').status === undefined && A.answers().length === 0"
sleep 0.3
check 'the mock received the denial of that request' "$(actions "len(a) == 1 and a[-1]['type'] == 'runtime-request.respond' and a[-1]['decision'] == 'decline' and a[-1]['requestId'] == 'request-9'")"
run "A.chevron(A.row('thread-run').title).emit('clicked', 1)"

# --- "+ n more" and a finished session ---------------------------------------

mock thread -d '{"id":"thread-new","title":"A fourth one","status":"running","activityRunStatus":"running","activeRunId":"run-new"}'
wait_check 'a fourth session: "+ 1 more" again' "A.rows().length === 4 && A.row('more').title === '+ 1 more'"
run "A.row('more').activate()"
check 'the row shows all' "A.rows().length === 4 && A.row('more') === undefined && A.row('thread-error') !== undefined"
ended="$(date -u -d '117 seconds ago' +%Y-%m-%dT%H:%M:%S.000Z)"
mock thread -d "{\"id\":\"thread-new\",\"status\":\"completed\",\"activityRunStatus\":null,\"activeRunId\":null,\"latestRunCompletedAt\":\"$ended\"}"
wait_check 'a session that finishes gets a check' "A.row('thread-new')?.status === 'done' && A.mod().expirySource !== 0"
wait_check 'and is gone when its two minutes are over' "A.row('thread-new') === undefined" 6
run 'visor.notch.close()'
shell_wait_for 'visor.notch.state !== "open"'
check 'closing the panel stops the tick and folds the list' "A.mod().tickSource === 0 && A.mod().showAll === false"

# --- the command -------------------------------------------------------------

run 'visor.notch.open()'
shell_wait_for 'visor.notch.state === "open"'
run 'visor.content.sheet.entry.grab_key_focus()'
check 'typing "t3 <text>" offers the thread that was active last and a new one' \
    'A.type("t3 run the tests").then(() => A.results().join(" / ") === "Send to A fourth one / Start a new thread" || A.results().join(" / "))'
check 'Enter sends and closes the panel' 'A.enter().then(() => visor.notch.state !== "open" || visor.notch.state)'
sleep 0.3
check 'the mock received the message' "$(actions "a[-1]['type'] == 'message.dispatch' and a[-1]['text'] == 'run the tests' and a[-1]['threadId'] == 'thread-new'")"
check 'the second result starts a thread in the same project' \
    "(async () => { const results = await A.mod().commands[0].resolve('write the docs'); results[1].activate(); await A.wait(400); return results.length === 2 && A.rows().some(r => r.title === 'write the docs'); })()"
check 'the mock received the launch' "$(actions "a[-1]['type'] == 'launchThread' and a[-1]['projectId'] == 'project-visor' and a[-1]['initialMessage']['text'] == 'write the docs' and a[-1]['modelSelection']['model'] == 'gpt-5.5'")"
check 'no command without a text' "A.mod().commands[0].resolve('  ').length === 0"

# --- the server goes and comes back ---------------------------------------------

check 'every stream item was acknowledged and one ticket was used' "$(mock_state "s['clients'] == 1 and s['tickets'] == 1 and s['acks'] >= 8")"
stop_mock
wait_check 'server gone: the rows vanish' "A.rows().length === 0 && A.chip() === null && visor.content.attention === null && !A.mod().client.connected"
check 'no command without a server' "A.mod().commands[0].resolve('hello').length === 0"
run 'A.wait(2500)'
check 'it keeps trying, quietly' "A.mod().client.retrySource !== 0 && A.rows().length === 0"
start_mock --fixture shots
wait_check 'server back: connected again, the rows return' "A.mod().client.connected && A.ids() === 'thread-wait,thread-run,thread-done'" 8
wait_check 'the waiting agent flashes again' "visor.content.attention === 'waiting' && A.chip() !== null"

# --- an incompatible server ----------------------------------------------------

stop_mock
shell_wait_for "!A.mod().client.connected"
start_mock --protocol 3
run 'A.wait(3000)'
check 'another protocol version: empty' "A.rows().length === 0 && !A.mod().client.connected"
check 'and one line in the log' "$(tail -n "+$((log_before + 1))" "$HOME/shell.log" | grep -c 'orchestration protocol 3') === 1"

# --- turned off ------------------------------------------------------------------

stop_mock
start_mock
wait_check 'a compatible server again' "A.mod().client.connected && A.rows().length === 4" 8
mock 'wait?thread=thread-run&request=request-big&prompt=ls&projection=big'
wait_check 'an answer of 5 MB closes the socket; after three of them the command stays unknown' \
    "A.mod().failures.get('request-big')?.count === 3 && A.mod().client.connected && A.mod().client.synced" 15
check 'the row has no Allow' \
    "A.row('thread-run').subtitle === 'visor · Answer this request in T3 Code' && A.row('thread-run').controls === undefined && A.row('thread-run').primary.label === 'Open in T3 Code'"
before="$(curl -s "http://127.0.0.1:$port/__mock/state" | python3 -c 'import json,sys; print(json.load(sys.stdin)["tickets"])')"
run 'A.wait(2500)'
check 'and the connection stays' "A.mod().client.connected && $(mock_state "s['tickets'] == $before")"
run "visor.content.registry.setEnabled('t3', false)"
check 'disable closes the socket and removes every source' \
    "(() => { const m = A.mod(); return m.client === null && m.tickSource === 0 && m.expirySource === 0 && A.rows().length === 0 && visor.content.attention === null; })()"
sleep 0.5
check 'the server sees no client' "$(mock_state "s['clients'] == 0")"
run "visor.content.registry.setEnabled('t3', true)"
wait_check 'enable connects again' "A.mod().client.connected && A.rows().length === 4" 8

# --- where the token is ----------------------------------------------------------
if dconf dump / | grep -q 'mock-token' || grep -qa 'mock-token' "$XDG_CONFIG_HOME/dconf/user" ||
    grep -q 'mock-token' "$HOME/shell.log"; then
    echo 'FAIL  the token is in dconf or in the log of the shell'
    fail=1
else
    echo 'ok    the token is neither in dconf nor in the log of the shell'
fi
run "Main.extensionManager.disableExtension('visor@taulit.github.io')"
shell_wait_for "Main.extensionManager.lookup('visor@taulit.github.io').state !== 1"
if [[ "$(keyring_lookup "http://127.0.0.1:$port")" == mock-token ]]; then
    echo 'ok    disabling the extension leaves the token in the keyring'
else
    echo 'FAIL  disabling the extension removed the token from the keyring'
    fail=1
fi

noise="$(tail -n "+$((log_before + 1))" "$HOME/shell.log" | grep -E 'JS ERROR|WARNING|CRITICAL|has been already disposed' || true)"
if [[ -z "$noise" ]]; then
    echo "ok    no shell warnings"
else
    echo "FAIL  shell warnings:"
    head -n 20 <<<"$noise"
    fail=1
fi
((fail == 0)) && echo "PASS"
exit "$fail"
