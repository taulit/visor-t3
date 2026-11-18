// The access token of T3 Code in the keyring of the user (libsecret, the
// Secret Service on the session bus), one item per origin. Used by the
// settings window, which stores and clears it, and by the module in the
// shell, which reads it. Only the async calls: a keyring that is locked asks
// for its password and must not hold up the shell meanwhile. No St, Clutter
// or Gtk here, so both processes can load it. The token is never logged.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Secret from 'gi://Secret';

/** Long enough to type the password of a locked keyring, short enough for a service that hangs. */
const TIMEOUT_SECONDS = 60;

let schema: Secret.Schema | null = null;
const t3Schema = (): Secret.Schema =>
  (schema ??= new Secret.Schema('io.github.taulit.Visor.T3', Secret.SchemaFlags.NONE, {
    origin: Secret.SchemaAttributeType.STRING,
  }));

/**
 * Runs one call of libsecret; null when the keyring cannot be used: no
 * service, the unlock was dismissed, `cancellable` was cancelled or the
 * service took longer than the timeout.
 */
function ask<T>(
  cancellable: Gio.Cancellable,
  begin: (callback: (source: unknown, result: Gio.AsyncResult) => void) => void,
  finish: (result: Gio.AsyncResult) => T,
): Promise<{ value: T } | null> {
  return new Promise(resolve => {
    // Cancelling makes libsecret dismiss a prompt that is still open.
    let timeout = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, TIMEOUT_SECONDS, () => {
      timeout = 0;
      cancellable.cancel();
      return GLib.SOURCE_REMOVE;
    });
    try {
      begin((_source, result) => {
        if (timeout) GLib.source_remove(timeout);
        timeout = 0;
        try {
          resolve({ value: finish(result) });
        } catch {
          resolve(null);
        }
      });
    } catch {
      if (timeout) GLib.source_remove(timeout);
      resolve(null);
    }
  });
}

/** The token stored for `origin` ('' when there is none), or null when the keyring cannot be used. */
export async function lookupToken(
  origin: string,
  cancellable: Gio.Cancellable,
): Promise<string | null> {
  const found = await ask(
    cancellable,
    callback => Secret.password_lookup(t3Schema(), { origin }, cancellable, callback),
    result => Secret.password_lookup_finish(result),
  );
  return found ? (found.value ?? '') : null;
}

/** Stores the token for `origin`, in place of an older one. False when the keyring cannot be used. */
export async function storeToken(
  origin: string,
  token: string,
  cancellable: Gio.Cancellable,
): Promise<boolean> {
  const stored = await ask(
    cancellable,
    callback =>
      Secret.password_store(
        t3Schema(),
        { origin },
        Secret.COLLECTION_DEFAULT,
        // Shown by keyring applications such as Seahorse; not translated, as it is stored.
        `Visor: T3 Code (${origin})`,
        token,
        cancellable,
        callback,
      ),
    result => Secret.password_store_finish(result),
  );
  return stored?.value === true;
}

/** Removes the token stored for `origin`. False when the keyring cannot be used. */
export async function clearToken(origin: string, cancellable: Gio.Cancellable): Promise<boolean> {
  const cleared = await ask(
    cancellable,
    callback => Secret.password_clear(t3Schema(), { origin }, cancellable, callback),
    result => Secret.password_clear_finish(result),
  );
  return cleared !== null;
}

/**
 * Makes sure a token can be stored: stores a probe item and removes it again.
 * A locked keyring asks for its password here, and a missing default keyring
 * is created, before anything that cannot be repeated is done. False when the
 * keyring cannot be used or the user dismissed the prompt.
 */
export async function unlockKeyring(cancellable: Gio.Cancellable): Promise<boolean> {
  const probe = 'visor:probe';
  if (!(await storeToken(probe, 'probe', cancellable))) return false;
  await clearToken(probe, cancellable);
  return true;
}

/**
 * The Secret Service left the bus: libsecret keeps its connection to the one
 * that is gone and would ask the next one with a session it does not know.
 */
export function keyringServiceGone(): void {
  Secret.Service.disconnect();
}
