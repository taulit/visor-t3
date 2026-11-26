// The connection to one paired T3 Code server, see docs/protocol.md:
// descriptor, WebSocket ticket, socket, the shell stream. The module keeps
// one per server. It reconnects with a growing wait and at once when the
// network or the local server's runtime file changes. The access token is in
// the keyring (keyring.ts), stored for the origin of the server; a keyring
// that had no answer is asked again when the Secret Service appears on the
// session bus. Without a token it does nothing at all, and a token the server
// refuses is not tried again until the pairing changes.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';

import { fetchText, runtimePath, type Answer } from './fetch.js';
import { keyringServiceGone, lookupToken } from './keyring.js';
import {
  METHODS,
  PONG_FRAME,
  ackFrame,
  applyShellItem,
  backoffSeconds,
  decodeDescriptor,
  decodeFrames,
  decodeTicket,
  descriptorUrl,
  emptyShell,
  hostOf,
  isCompatible,
  isSnapshot,
  requestFrame,
  socketUrl,
  subscribeShellPayload,
  threadAppLink,
  threadLink,
  ticketUrl,
  type Descriptor,
  type ShellState,
} from './protocol.js';

/**
 * The pairings the keyring had no answer for, as `<serial> <origin>`. A
 * locked keyring asks for its password; this keeps an extension that is
 * disabled and enabled again (every time the screen is unlocked) from asking
 * over and over. It lasts as long as the shell and ends when the pairing
 * changes or a keyring service starts.
 */
const keyringFailedFor = new Set<string>();

/**
 * A larger frame closes the socket. A thread projection that large is not
 * read: its command stays unknown and is answered in T3 Code.
 */
const MAX_FRAME_BYTES = 4 * 1024 * 1024;
const MAX_HTTP_BYTES = 256 * 1024;
/** The shared session drops a socket that is silent for its timeout; a ping keeps it. */
const KEEPALIVE_SECONDS = 10;
const REQUEST_TIMEOUT_SECONDS = 20;

interface Pending {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timeout: number;
}

export class T3Client {
  /** The threads of the server; empty while there is no connection. */
  shell: ShellState = emptyShell();
  descriptor: Descriptor | null = null;
  connected = false;
  /** The first snapshot of this connection has arrived: `shell` is what the server has. */
  synced = false;

  private cancellable: Gio.Cancellable | null = null;
  private socket: Soup.WebsocketConnection | null = null;
  private pending = new Map<string, Pending>();
  private shellRequest: string | null = null;
  private nextId = 1;
  private attempt = 0;
  private retrySource = 0;
  private connecting = false;
  private running = false;
  private monitor: Gio.FileMonitor | null = null;
  private network: Gio.NetworkMonitor | null = null;
  private incompatibleLogged = false;
  /** The server refused the token; nothing is tried until the token or the address changes. */
  private rejected = false;
  /** The access token, read from the keyring; empty until then and when not paired. */
  private token = '';
  private lookup: Gio.Cancellable | null = null;
  private keyringWatch = 0;
  /** Whether the Secret Service is on the session bus; null until the bus has said. */
  private keyringOwned: boolean | null = null;

  /** The counter of token changes this client last read the keyring for. */
  private serial = 0;

  /**
   * `origin` is the server and the origin its token was issued for; the token
   * goes nowhere else. `changed` is called when the threads or the connection
   * changed.
   */
  constructor(
    private http: Soup.Session,
    readonly origin: string,
    private changed: () => void,
  ) {}

  /** What to call the server: what it calls itself, else its host. */
  get label(): string {
    return this.descriptor?.label || hostOf(this.origin);
  }

  /** `serial` is the counter of token changes in the settings. */
  start(serial: number): void {
    if (this.running) return;
    this.running = true;
    this.serial = serial;
    this.network = Gio.NetworkMonitor.get_default();
    this.network.connectObject('network-changed', () => this.retryNow(), this);
    try {
      // The server writes this file when it starts and removes it when it stops.
      this.monitor = Gio.File.new_for_path(runtimePath()).monitor_file(
        Gio.FileMonitorFlags.NONE,
        null,
      );
      this.monitor.connectObject('changed', () => this.retryNow(), this);
    } catch {
      this.monitor = null;
    }
    this.keyringWatch = Gio.bus_watch_name(
      Gio.BusType.SESSION,
      'org.freedesktop.secrets',
      Gio.BusNameWatcherFlags.NONE,
      () => {
        // Only a service that was not there before: one that was there and
        // gave no answer had its prompt dismissed and is not asked again.
        const appeared = this.keyringOwned === false;
        this.keyringOwned = true;
        if (!appeared || this.token) return;
        keyringFailedFor.clear();
        this.load();
      },
      () => {
        if (this.keyringOwned) keyringServiceGone();
        this.keyringOwned = false;
      },
    );
    this.load();
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    Gio.bus_unwatch_name(this.keyringWatch);
    this.keyringWatch = 0;
    this.keyringOwned = null;
    this.network?.disconnectObject(this);
    this.network = null;
    this.monitor?.disconnectObject(this);
    this.monitor?.cancel();
    this.monitor = null;
    this.forget();
    this.drop();
    this.attempt = 0;
    this.incompatibleLogged = false;
    this.rejected = false;
  }

  /** The address that opens a thread in T3 Code. */
  /** The link for the desktop app, which need not be installed. */
  appLink(threadId: string): string | null {
    return this.descriptor ? threadAppLink(this.descriptor.environmentId, threadId) : null;
  }

  link(threadId: string): string | null {
    return this.descriptor
      ? threadLink(this.origin, this.descriptor.environmentId, threadId)
      : null;
  }

  /** Sends a request; the promise rejects with a short reason. */
  request(method: string, payload: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const socket = this.socket;
      // A socket that is closing takes no request; waiting for the timeout helps nobody.
      if (!socket || !this.connected || socket.get_state() !== Soup.WebsocketState.OPEN) {
        reject(new Error('not connected'));
        return;
      }
      const requestId = String(this.nextId++);
      const timeout = GLib.timeout_add_seconds(
        GLib.PRIORITY_DEFAULT,
        REQUEST_TIMEOUT_SECONDS,
        () => {
          this.pending.delete(requestId);
          reject(new Error('timed out'));
          return GLib.SOURCE_REMOVE;
        },
      );
      this.pending.set(requestId, { resolve, reject, timeout });
      this.sendText(socket, requestFrame(requestId, method, payload));
    });
  }

  command(command: unknown): Promise<unknown> {
    return this.request(METHODS.dispatchCommand, command);
  }

  // --- connecting ---

  /**
   * A token in the keyring changed, of this server or of another one: read
   * it again. The same token keeps the connection as it is, a refused one
   * stays refused; another token starts over.
   */
  restart(serial: number): void {
    if (!this.running || serial === this.serial) return;
    this.serial = serial;
    this.load(true);
  }

  private forget(): void {
    this.lookup?.cancel();
    this.lookup = null;
    this.token = '';
  }

  /**
   * Reads the token of the server from the keyring, then connects. With
   * `keep`, what is there stays unless the keyring has another token.
   */
  private load(keep = false): void {
    if (keep) {
      this.lookup?.cancel();
      this.lookup = null;
    } else {
      this.forget();
    }
    if (!this.running) return;
    const pairing = `${this.serial} ${this.origin}`;
    if (keyringFailedFor.has(pairing)) return;
    const cancellable = (this.lookup = new Gio.Cancellable());
    lookupToken(this.origin, cancellable)
      .catch(() => null)
      .then(token => {
        // Cancelled by a change or by stop(): that is no answer of the keyring.
        if (this.lookup !== cancellable) return;
        this.lookup = null;
        // A keyring that does not answer now takes nothing away from a token it gave.
        if (keep && (token === this.token || (token === null && this.token))) return;
        if (keep) {
          this.drop();
          this.attempt = 0;
          this.rejected = false;
          this.token = '';
          this.changed();
        }
        if (token === null) {
          // One keyring for all servers: one line per pairing is enough.
          const first = ![...keyringFailedFor].some(key => key.startsWith(`${this.serial} `));
          keyringFailedFor.add(pairing);
          if (first)
            log(
              'The keyring is not available, so the access token of T3 Code cannot be read; ' +
                'its sessions are not shown. Not asking again until a keyring service ' +
                'starts or Visor is paired anew.',
            );
          return;
        }
        keyringFailedFor.delete(pairing);
        this.token = token;
        this.connect();
      });
  }

  /** The network or the server's runtime file changed: do not sit out the wait. */
  private retryNow(): void {
    if (!this.running || this.connected || this.connecting || this.rejected) return;
    this.attempt = 0;
    this.connect();
  }

  private connect(): void {
    if (this.retrySource) GLib.source_remove(this.retrySource);
    this.retrySource = 0;
    const token = this.token;
    // Not paired: nothing to do until the settings change.
    if (!this.running || this.connecting || this.connected || !token || this.rejected) return;
    this.connecting = true;
    const cancellable = (this.cancellable = new Gio.Cancellable());
    this.open(token, cancellable)
      .catch(() => false)
      .then(opened => {
        if (cancellable.is_cancelled()) return;
        this.connecting = false;
        if (!opened) this.retryLater();
      });
  }

  private retryLater(): void {
    if (!this.running || this.retrySource || this.rejected) return;
    this.retrySource = GLib.timeout_add_seconds(
      GLib.PRIORITY_DEFAULT,
      backoffSeconds(this.attempt++),
      () => {
        this.retrySource = 0;
        this.connect();
        return GLib.SOURCE_REMOVE;
      },
    );
  }

  /** True when the socket is open. A server that is not there is no error. */
  private async open(token: string, cancellable: Gio.Cancellable): Promise<boolean> {
    // The token goes to the server it was issued by and to no other.
    const origin = this.origin;

    const about = (await this.fetch('GET', descriptorUrl(origin), null, cancellable)).body;
    const descriptor = about ? decodeDescriptor(about) : null;
    if (!descriptor || cancellable.is_cancelled()) return false;
    if (!isCompatible(descriptor)) {
      if (!this.incompatibleLogged) {
        this.incompatibleLogged = true;
        log(
          `T3 Code at ${origin} speaks orchestration protocol ${descriptor.version ?? 'unknown'}, ` +
            'this module another one; its sessions are not shown.',
        );
      }
      return false;
    }

    const answer = await this.fetch('POST', ticketUrl(origin), token, cancellable);
    if (cancellable.is_cancelled()) return false;
    if (answer.status === 401 || answer.status === 403) {
      // Asking again gets the same answer; the token itself is never logged.
      this.rejected = true;
      log(
        `T3 Code at ${origin} refused the access token (HTTP ${answer.status}); ` +
          'pair again in the settings of Visor: T3 Code. Not trying again until then.',
      );
      return false;
    }
    const ticket = decodeTicket(answer.body ?? '');
    if (!ticket) return false;

    const socket = await this.openSocket(socketUrl(origin, ticket), cancellable);
    if (!socket) return false;
    if (cancellable.is_cancelled()) {
      socket.close(Soup.WebsocketCloseCode.NORMAL, null);
      return false;
    }

    this.descriptor = descriptor;
    this.socket = socket;
    this.connected = true;
    // The wait before the next attempt starts over once the first snapshot is
    // here, not now: a server that accepts and then ends the stream would be
    // asked every second.
    socket.max_incoming_payload_size = MAX_FRAME_BYTES;
    socket.keepalive_interval = KEEPALIVE_SECONDS;
    socket.connectObject(
      'message',
      (_socket: Soup.WebsocketConnection, _type: Soup.WebsocketDataType, bytes: GLib.Bytes) =>
        this.receive(bytes),
      'closed',
      () => this.lost(socket),
      this,
    );
    this.shellRequest = String(this.nextId++);
    this.sendText(
      socket,
      requestFrame(this.shellRequest, METHODS.subscribeShell, subscribeShellPayload(descriptor)),
    );
    return true;
  }

  private fetch(
    method: string,
    url: string,
    token: string | null,
    cancellable: Gio.Cancellable,
  ): Promise<Answer> {
    const message = Soup.Message.new(method, url);
    if (!message) return Promise.resolve({ status: 0, body: null });
    // A redirect would carry the token or the ticket to another place.
    message.add_flags(Soup.MessageFlags.NO_REDIRECT);
    if (token) message.get_request_headers().append('Authorization', `Bearer ${token}`);
    return fetchText(this.http, message, MAX_HTTP_BYTES, cancellable);
  }

  private openSocket(
    url: string,
    cancellable: Gio.Cancellable,
  ): Promise<Soup.WebsocketConnection | null> {
    return new Promise(resolve => {
      const message = Soup.Message.new('GET', url);
      if (!message) {
        resolve(null);
        return;
      }
      // The ticket is in the address.
      message.add_flags(Soup.MessageFlags.NO_REDIRECT);
      this.http.websocket_connect_async(
        message,
        null,
        null,
        GLib.PRIORITY_DEFAULT,
        cancellable,
        (_source, result) => {
          try {
            resolve(this.http.websocket_connect_finish(result));
          } catch {
            resolve(null);
          }
        },
      );
    });
  }

  // --- the socket ---

  /** Sends on a socket that is open; one that is closing would warn and send nothing. */
  private sendText(socket: Soup.WebsocketConnection, text: string): boolean {
    if (socket.get_state() !== Soup.WebsocketState.OPEN) return false;
    socket.send_text(text);
    return true;
  }

  private close(socket: Soup.WebsocketConnection): void {
    if (socket.get_state() === Soup.WebsocketState.OPEN)
      socket.close(Soup.WebsocketCloseCode.NORMAL, null);
  }

  /** The server may send JSON as text or as bytes; both are read the same way. */
  private receive(bytes: GLib.Bytes): void {
    const socket = this.socket;
    const data = bytes.get_data();
    if (!socket || !data) return;
    let shellChanged = false;
    for (const frame of decodeFrames(new TextDecoder().decode(data))) {
      switch (frame.tag) {
        case 'chunk':
          // Without the ack the server sends nothing more on this stream.
          this.sendText(socket, ackFrame(frame.requestId));
          if (frame.requestId !== this.shellRequest) break;
          for (const item of frame.values) {
            if (!applyShellItem(this.shell, item)) continue;
            shellChanged = true;
            if (!this.synced && isSnapshot(item)) {
              this.synced = true;
              this.attempt = 0;
            }
          }
          break;
        case 'exit': {
          if (frame.requestId === this.shellRequest) {
            // The stream ended; a new connection starts a new one.
            this.close(socket);
            break;
          }
          const pending = this.pending.get(frame.requestId);
          if (!pending) break;
          this.pending.delete(frame.requestId);
          GLib.source_remove(pending.timeout);
          if (frame.ok) pending.resolve(frame.value);
          else pending.reject(new Error(frame.error));
          break;
        }
        case 'ping':
          this.sendText(socket, PONG_FRAME);
          break;
        case 'defect':
          this.close(socket);
          break;
        case 'pong':
          break;
      }
    }
    if (shellChanged) this.changed();
  }

  private lost(socket: Soup.WebsocketConnection): void {
    if (socket !== this.socket) return;
    this.drop();
    this.changed();
    this.retryLater();
  }

  /** Forgets the connection and everything that came over it. */
  private drop(): void {
    this.cancellable?.cancel();
    this.cancellable = null;
    this.connecting = false;
    if (this.retrySource) GLib.source_remove(this.retrySource);
    this.retrySource = 0;
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      socket.disconnectObject(this);
      this.close(socket);
    }
    for (const pending of this.pending.values()) {
      GLib.source_remove(pending.timeout);
      pending.reject(new Error('not connected'));
    }
    this.pending.clear();
    this.shellRequest = null;
    this.connected = false;
    this.synced = false;
    this.descriptor = null;
    this.shell = emptyShell();
  }
}
