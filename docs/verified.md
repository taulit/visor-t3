# Verified facts

What the module relies on and how it was checked. Moved here from `docs/verified.md` of Visor when the
module became an extension of its own.

## libsecret for the T3 Code token

Checked on 2026-11-17 (gnome-shell 50.5, gjs 1.88.1, libsecret 0.21.8).

- **`gi://Secret` in the shell process: confirmed at runtime.** `Secret-1.typelib` is part of the package
  `libsecret` (`/usr/lib/girepository-1.0/Secret-1.typelib`), which gnome-shell depends on and links
  (`ldd /usr/bin/gnome-shell` lists `libsecret-1.so.0`). In the sandbox, `import('gi://Secret')` inside the
  shell and `Secret.password_lookup` with the schema `io.github.taulit.Visor.T3` returned a token stored with
  `secret-tool`; `tests/shell/t3.sh` runs on that path.
- **`gi://Secret` in the prefs process: confirmed at runtime.** `tests/shell/prefs.sh` pairs through the
  window (`org.gnome.Shell.Extensions`), which stores with `Secret.password_store`; the test reads the item
  back with `secret-tool` and the shell connects with it.
- **A locked keyring.** `secret_password_lookup` unlocks an item it finds locked, which shows the keyring
  prompt of the shell (libsecret `secret-methods.c`, `on_lookup_searched` → `secret_service_unlock_dbus_paths`;
  **read from memory of the source, not runtime-tested** — the keyring of the sandbox is unlocked). Hence the
  rule in `src/client.ts`: one lookup per pairing, none again after a failure.
- **Review guidelines.** <https://gjs.guide/extensions/review-guidelines/review-guidelines.html>, read on
  2026-11-17: the page does not mention libsecret, the keyring or passwords at all. What it does say and
  what applies: "Extensions MUST NOT import `Gdk`, `Gtk` or `Adw` in the GNOME Shell process" (Secret is none
  of them and has no toolkit dependency), "Extensions MUST NOT include binary executables or libraries"
  (libsecret comes with the system, nothing is bundled), and the rules for GSettings schemas, which the
  remaining keys follow. So nothing forbids it; that it is welcome is our reading, not a quote.
- **The sandbox.** The Secret Service is a name on the session bus. `scripts/nested.sh` of the Visor repository gives the sandbox
  its own bus, masks D-Bus activation of `org.freedesktop.secrets`, `org.gnome.keyring` and the secret
  portal there, and starts one `gnome-keyring-daemon --unlock --components=secrets` with the sandbox `HOME`,
  `XDG_DATA_HOME` and `XDG_RUNTIME_DIR` (keyring files in `$sandbox/home/.local/share/keyrings`, control
  socket in `$sandbox/run/keyring`). `scripts/lib/keyring.sh` there refuses to run `secret-tool` unless all of
  these point into the sandbox. With `--no-keyring` no daemon runs and a call fails at once.

## Complexity worth knowing (from the review of Visor, before the move)

| File            | Note                                                                                                                                                                                                                                                                                                                            |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/module.ts` | Nine maps and sets track requests (`prompts`, `asking`, `failures`, `current`, `answered`, `stopped`, `errors`, `details`, `announced`, `:80-95`). The rule for when Allow and Deny may appear is not in one place: it is spread over three (the failure check at `:429-432`, the buttons at `:448-456`, the filter at `:687`). |
| `src/client.ts` | Seven pieces of state decide whether a retry happens and when: six booleans (`connected`, `synced`, `connecting`, `running`, `rejected`, `incompatibleLogged`) and the id of the retry timer (`:73-91`); read `retryLater` (`:248`) and `retryNow` (`:225`) with them.                                                          |
