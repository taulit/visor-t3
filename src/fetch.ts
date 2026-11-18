// What the module in the shell and the settings window both need to find
// and ask a T3 Code server. No St, Clutter or Gtk here, so both processes
// can load it.
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';

import type Gio from 'gi://Gio';

/** The file in which a running server says where it listens: below `$T3CODE_HOME` or `~/.t3`. */
export function runtimePath(): string {
  const base = GLib.getenv('T3CODE_HOME') || GLib.build_filenamev([GLib.get_home_dir(), '.t3']);
  return GLib.build_filenamev([base, 'userdata', 'server-runtime.json']);
}

export interface Answer {
  /** 0 when there was no answer. */
  status: number;
  /** Of a plain 200 answer of at most the allowed size; a redirect is not followed. */
  body: string | null;
}

/** Sends `message` and reads the answer as text. Never rejects. */
export function fetchText(
  http: Soup.Session,
  message: Soup.Message,
  maxBytes: number,
  cancellable: Gio.Cancellable,
): Promise<Answer> {
  return new Promise(resolve => {
    http.send_and_read_async(message, GLib.PRIORITY_DEFAULT, cancellable, (_source, result) => {
      try {
        const data = http.send_and_read_finish(result).get_data();
        const status = message.get_status();
        const ok = status === Soup.Status.OK && data !== null && data.length <= maxBytes;
        resolve({ status, body: ok ? new TextDecoder().decode(data) : null });
      } catch {
        resolve({ status: 0, body: null });
      }
    });
  });
}
