# Changelog

## [0.1.0] - unreleased

- Moved out of [Visor](https://github.com/taulit/visor), where T3 Code was a built-in module, into an extension of its own that uses the module API v1. Same behaviour: sessions in Now, approvals in the row, reply, stop, the command `t3`, pairing with a link, the token in the keyring.
- The settings are its own now (`org.gnome.shell.extensions.visor-t3`): pairing, server address and "Show briefly when an agent is waiting". Nothing was released before, so nothing is migrated: pair once.
- "Open in T3 Code" opens the desktop app through `t3code://threads/<environment>/<thread>` when the scheme is registered, the browser otherwise.
