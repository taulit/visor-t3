// Pairing with T3 Code servers, see docs/protocol.md §2: the user pastes a
// pairing link of a server (this machine or another one), the window
// exchanges it for an access token and stores that in the keyring
// (keyring.ts), where the module finds it; the settings only list the
// origins that are paired. For the server of this machine the window can
// also ask the T3 Code command line for the code itself. Neither a code nor a
// token is ever logged.
import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';
import Soup from 'gi://Soup?version=3.0';

import { gettext as _ } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import { fetchText, runtimePath } from './fetch.js';
import { clearToken, storeToken, unlockKeyring } from './keyring.js';
import {
  MAX_SERVERS,
  SERVERS_KEY,
  TOKEN_SERIAL_KEY,
  carryOverPairing,
  cliPairingArgs,
  decodeAccessToken,
  decodeCliPairing,
  exchangeError,
  isInsecurePairing,
  parsePairing,
  serverList,
  tokenRequestBody,
  tokenUrl,
  withServer,
  withoutServer,
  type PairingError,
} from './pairing.js';
import {
  decodeDescriptor,
  decodeRuntimeState,
  descriptorUrl,
  hostOf,
  isCompatible,
  isLocalOrigin,
} from './protocol.js';

const TIMEOUT_SECONDS = 10;
const MAX_ANSWER_BYTES = 64 * 1024;

/** The origin of the server running on this machine, from its runtime file, or null. */
function localOrigin(): string | null {
  try {
    const [, bytes] = GLib.file_get_contents(runtimePath());
    return bytes.length <= MAX_ANSWER_BYTES
      ? decodeRuntimeState(new TextDecoder().decode(bytes))
      : null;
  } catch {
    return null;
  }
}

/**
 * The command line of T3 Code: the one T3 Code installs below its home, next
 * to the runtime file of the server it belongs to, else `t3` on the PATH.
 */
function findCli(): string | null {
  const base = GLib.getenv('T3CODE_HOME') || GLib.build_filenamev([GLib.get_home_dir(), '.t3']);
  const installed = GLib.build_filenamev([base, 'bin', 't3']);
  if (GLib.file_test(installed, GLib.FileTest.IS_EXECUTABLE)) return installed;
  return GLib.find_program_in_path('t3');
}

/** Asks the command line for a one-time pairing code of the local server; null when it fails. */
function cliPairingCode(cli: string, cancellable: Gio.Cancellable): Promise<string | null> {
  return new Promise(resolve => {
    try {
      const process = Gio.Subprocess.new(
        [cli, ...cliPairingArgs(`Visor (${GLib.get_host_name()})`)],
        Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE,
      );
      process.communicate_utf8_async(null, cancellable, (_source, result) => {
        try {
          const [, stdout] = process.communicate_utf8_finish(result);
          resolve(process.get_successful() ? decodeCliPairing(stdout ?? '') : null);
        } catch {
          resolve(null);
        }
      });
    } catch {
      resolve(null);
    }
  });
}

/**
 * Exchanges a one-time pairing code at the server for an access token.
 * Ends with 'unreachable' when `cancellable` is cancelled before the code is
 * sent; once it is on its way the answer is awaited, bounded by the timeout
 * of `http`, so that a token the server issued is not thrown away.
 */
async function exchangePairingCode(
  http: Soup.Session,
  origin: string,
  code: string,
  cancellable: Gio.Cancellable,
): Promise<{ token: string } | { error: PairingError }> {
  const about = Soup.Message.new('GET', descriptorUrl(origin));
  const exchange = Soup.Message.new('POST', tokenUrl(origin));
  if (!about || !exchange) return { error: 'unreachable' };
  // The code goes to the server the link names and is not carried along by a redirect.
  about.add_flags(Soup.MessageFlags.NO_REDIRECT);
  exchange.add_flags(Soup.MessageFlags.NO_REDIRECT);
  // The version first: a server that speaks another protocol keeps its code unused.
  const descriptor = decodeDescriptor(
    (await fetchText(http, about, MAX_ANSWER_BYTES, cancellable)).body ?? '',
  );
  if (!descriptor) return { error: 'unreachable' };
  if (!isCompatible(descriptor)) return { error: 'incompatible' };

  const label = `Visor (${GLib.get_host_name()})`;
  exchange.set_request_body_from_bytes(
    'application/x-www-form-urlencoded',
    new GLib.Bytes(new TextEncoder().encode(tokenRequestBody(code, label))),
  );
  if (cancellable.is_cancelled()) return { error: 'unreachable' };
  const answer = await fetchText(http, exchange, MAX_ANSWER_BYTES, new Gio.Cancellable());
  if (answer.status !== Soup.Status.OK) return { error: exchangeError(answer.status) };
  const token = decodeAccessToken(answer.body ?? '');
  return token ? { token } : { error: 'rejected' };
}

function errorText(error: PairingError): string {
  switch (error) {
    case 'invalid':
      return _('This is not a pairing link');
    case 'insecure':
      return _('Use https or a Tailscale address for another machine');
    case 'rejected':
      return _('The link is wrong or has expired');
    case 'incompatible':
      return _('This version of T3 Code does not fit Visor');
    case 'keyring':
      return _('The keyring is not available');
    case 'full':
      return _('Disconnect a server first');
    case 'cli':
      return _('T3 Code gave no pairing code');
    default:
      return _('The server cannot be reached');
  }
}

/**
 * The group that lists the paired servers and the one that pairs more. A
 * pairing that has not sent its code yet ends when `window` closes.
 */
export function pairingGroups(
  settings: Gio.Settings,
  window: Adw.PreferencesWindow,
): Adw.PreferencesGroup[] {
  carryOverPairing(settings);
  const paired = new Adw.PreferencesGroup({ title: _('Servers') });
  const group = new Adw.PreferencesGroup({
    title: _('Add a server'),
    // The description of a group is Pango markup, and the text has an ampersand.
    description: GLib.markup_escape_text(
      _(
        'Create a pairing link in T3 Code under Settings → Sharing & access on each machine whose agents Visor should show, and paste it here.',
      ),
      -1,
    ),
  });
  const http = new Soup.Session({ timeout: TIMEOUT_SECONDS });
  let cancellable: Gio.Cancellable | null = null;
  let closed = false;
  /** Cancels the requests for the names of the servers when the window closes. */
  const naming = new Gio.Cancellable();
  /** What each server calls its machine, as far as it has said. */
  const labels = new Map<string, string>();

  const servers = (): string[] => serverList(settings.get_strv(SERVERS_KEY));

  // --- the paired servers ---
  const rows = new Map<string, Adw.ActionRow>();
  /** Tells the module in the shell that a token in the keyring changed. */
  const tokenChanged = (): void => {
    settings.set_int(TOKEN_SERIAL_KEY, (settings.get_int(TOKEN_SERIAL_KEY) + 1) % 1_000_000);
  };
  // The protocol lets no session revoke itself, so the token is only forgotten here.
  const forget = (origin: string): void => {
    settings.set_strv(SERVERS_KEY, withoutServer(servers(), origin));
    tokenChanged();
    // Not tied to the window: it may close before the keyring has answered.
    // Without a keyring there is nothing to remove.
    void clearToken(origin, new Gio.Cancellable());
  };
  const titleOf = (origin: string): string =>
    labels.get(origin) || (isLocalOrigin(origin) ? _('This machine') : hostOf(origin));
  const subtitleOf = (origin: string): string =>
    isLocalOrigin(origin) ? `${_('This machine')} · ${origin}` : origin;
  /** Asks the server what it calls its machine; its descriptor is public. */
  const askLabel = (origin: string): void => {
    if (labels.has(origin)) return;
    labels.set(origin, '');
    const message = Soup.Message.new('GET', descriptorUrl(origin));
    if (!message) return;
    message.add_flags(Soup.MessageFlags.NO_REDIRECT);
    void fetchText(http, message, MAX_ANSWER_BYTES, naming).then(answer => {
      const label = decodeDescriptor(answer.body ?? '')?.label ?? '';
      if (closed || !label) return;
      labels.set(origin, label);
      const row = rows.get(origin);
      if (row) row.title = label;
    });
  };
  const rowOf = (origin: string): Adw.ActionRow => {
    const row = new Adw.ActionRow({ title: titleOf(origin), subtitle: subtitleOf(origin) });
    row.add_prefix(new Gtk.Image({ icon_name: 'object-select-symbolic' }));
    const disconnect = new Gtk.Button({ label: _('Disconnect'), valign: Gtk.Align.CENTER });
    disconnect.connect('clicked', () => forget(origin));
    row.add_suffix(disconnect);
    return row;
  };

  // --- pairing one more ---
  const title = _('Pairing link or code');
  const entry = new Adw.PasswordEntryRow({ title });
  const connect = new Gtk.Button({
    label: _('Connect'),
    valign: Gtk.Align.CENTER,
    css_classes: ['suggested-action', 'visor-t3-connect'],
  });
  entry.add_suffix(connect);
  group.add(entry);
  // The class `error` of the row turns the accent of everything in it red,
  // the button included. The error is about what was typed, so the button
  // keeps the accent of the window. Removed again when the window closes.
  const css = new Gtk.CssProvider();
  css.load_from_string(
    'row.entry.error button.visor-t3-connect {' +
      ' --accent-bg-color: @accent_bg_color; --accent-fg-color: @accent_fg_color; }',
  );
  const display = window.get_display();
  Gtk.StyleContext.add_provider_for_display(display, css, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION);

  // --- this machine, through the command line of T3 Code ---
  const cli = findCli();
  const thisMachine = new Adw.ActionRow({
    title: _('This machine'),
    subtitle: _('Pair with the T3 Code server running here, without a link'),
  });
  const connectHere = new Gtk.Button({ label: _('Connect'), valign: Gtk.Align.CENTER });
  thisMachine.add_suffix(connectHere);
  // The whole row is the button: it says what Connect is for.
  thisMachine.activatable_widget = connectHere;
  group.add(thisMachine);

  // --- how to pair another machine ---
  const elsewhere = new Adw.ActionRow({
    title: _('Another machine'),
    // Not translated: a command. ADDRESS is what the user puts in.
    subtitle:
      't3 auth pairing create --scope orchestration:read --scope orchestration:operate ' +
      '--base-url http://ADDRESS:3773',
    subtitle_selectable: true,
  });
  elsewhere.add_css_class('property');
  group.add(elsewhere);

  const showError = (error: PairingError | null): void => {
    entry.title = error ? errorText(error) : title;
    if (error) entry.add_css_class('error');
    else entry.remove_css_class('error');
  };
  const finish = (): void => {
    cancellable = null;
    connect.sensitive = true;
    connectHere.sensitive = true;
  };

  /**
   * Spends `code` at `origin` and keeps the token. `getCode` runs once the
   * keyring is known to work, so that a code is made or spent only when the
   * token can be kept.
   */
  const pair = async (
    origin: string,
    getCode: (cancellable: Gio.Cancellable) => Promise<string | null>,
  ): Promise<void> => {
    if (cancellable) return;
    const list = servers();
    if (list.length >= MAX_SERVERS && !list.includes(origin)) {
      showError('full');
      return;
    }
    showError(null);
    connect.sensitive = false;
    connectHere.sensitive = false;
    const mine = (cancellable = new Gio.Cancellable());
    // The keyring first, unlocked: the code is good once, so it is spent only
    // when the token can be kept. The user may take their time with the
    // password; the keyring has a limit of its own.
    const usable = await unlockKeyring(mine);
    // The window closed meanwhile: its widgets are gone.
    if (closed) return;
    let result: { token: string } | { error: PairingError };
    if (!usable) {
      result = { error: 'keyring' };
    } else {
      const code = await getCode(mine);
      if (closed) return;
      result = code
        ? await exchangePairingCode(http, origin, code, mine)
        : { error: mine.is_cancelled() ? 'unreachable' : 'cli' };
    }
    // Not tied to the window: the code is spent, so the token is kept even
    // when the window closes now.
    const stored =
      'token' in result && (await storeToken(origin, result.token, new Gio.Cancellable()));
    if (!closed) {
      finish();
      if (!stored) showError('error' in result ? result.error : 'keyring');
    }
    if (!stored) return;
    // The token is for this origin; the module sends it nowhere else.
    settings.set_strv(SERVERS_KEY, withServer(servers(), origin));
    tokenChanged();
  };
  const run = (work: Promise<void>): void => {
    work.catch(() => {
      if (closed) return;
      finish();
      showError('unreachable');
    });
  };

  const pairPasted = (): void => {
    if (cancellable) return;
    const pasted = entry.text;
    const pairing = parsePairing(pasted);
    // The code is good once; it does not stay in the window.
    entry.text = '';
    if (!pairing) {
      showError(isInsecurePairing(pasted) ? 'insecure' : 'invalid');
      return;
    }
    // A bare code is one of this machine's server.
    const origin = pairing.origin ?? localOrigin();
    if (!origin) {
      showError('unreachable');
      return;
    }
    run(pair(origin, () => Promise.resolve(pairing.code)));
  };
  connect.connect('clicked', pairPasted);
  entry.connect('entry-activated', pairPasted);
  entry.connect('changed', () => {
    if (entry.text) showError(null);
  });
  connectHere.connect('clicked', () => {
    const origin = localOrigin();
    if (!origin || !cli) {
      showError('unreachable');
      return;
    }
    run(pair(origin, mine => cliPairingCode(cli, mine)));
  });

  const sync = (): void => {
    const list = servers();
    for (const [origin, row] of rows) {
      if (list.includes(origin)) continue;
      paired.remove(row);
      rows.delete(origin);
    }
    // A server paired anew is added last, as it is in the list: the order stays.
    for (const origin of list) {
      if (rows.has(origin)) continue;
      const row = rowOf(origin);
      rows.set(origin, row);
      paired.add(row);
      askLabel(origin);
    }
    paired.description = list.length > 0 ? '' : _('None yet, so no sessions are shown.');
    const local = localOrigin();
    thisMachine.visible = cli !== null && local !== null && !list.includes(local);
  };
  const handler = settings.connect(`changed::${SERVERS_KEY}`, sync);
  sync();

  window.connect('close-request', () => {
    closed = true;
    cancellable?.cancel();
    cancellable = null;
    naming.cancel();
    settings.disconnect(handler);
    Gtk.StyleContext.remove_provider_for_display(display, css);
    return false;
  });
  return [paired, group];
}
