// The agent sessions of the local T3 Code server as rows in "Now": what
// works, what finished, and above all what waits for an approval, which is
// given right in the row. The protocol is in docs/protocol.md.
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import St from 'gi://St';

import type {
  Command,
  ModuleContext,
  NowRow,
  PeekChip,
  Result,
  VisorModule,
} from './visor/index.js';
import { formatDuration, truncate } from './format.js';
import { T3Client } from './client.js';
import {
  APP_SCHEME,
  METHODS,
  MAX_REPLY,
  approvalPrompt,
  commandLines,
  fitsExpanded,
  fitsPreview,
  isWaiting,
  lastActive,
  launchPayload,
  mayAnswer,
  promptPreview,
  promptRetryMs,
  replyCommand,
  respondCommand,
  sessionsOf,
  stopCommand,
  visibleSessions,
  type Prompt,
  type Session,
} from './protocol.js';

const ICON = 'utilities-terminal-symbolic';
const FLASH_KEY = 'flash-on-waiting-agents';
const MORE_ID = 't3:more';

const ICONS: Record<Session['phase'], string> = {
  starting: 'content-loading-symbolic',
  working: 'content-loading-symbolic',
  approval: 'dialog-question-symbolic',
  question: 'dialog-question-symbolic',
  done: 'object-select-symbolic',
  error: 'dialog-warning-symbolic',
};

/** What an expanded row shows. Built once per thread and updated in place. */
interface Details {
  expand: () => St.Widget;
  message: St.Label | null;
  stop: St.Widget | null;
  /** The request Deny and Allow below the command were rendered for. */
  requestId: string | null;
  /** Shows the command of an approval, or none; null while the row is collapsed. */
  showCommand: ((prompt: Prompt | null) => void) | null;
}

const monotonicMs = (): number => GLib.get_monotonic_time() / 1000;

class T3Module implements VisorModule {
  readonly id = 't3';
  readonly name: string;
  readonly icon = ICON;
  readonly slot = 'now';
  readonly commands: Command[];

  private ctx: ModuleContext | null = null;
  private client: T3Client | null = null;
  private sessions: Session[] = [];
  /** What an approval asks, by request id. Only what is known and not empty. */
  private prompts = new Map<string, Prompt>();
  /** The requests whose command is asked for; the token tells an answer that came too late. */
  private asking = new Map<string, object>();
  /** Requests whose command could not be read: how often, and when to ask again (null: never). */
  private failures = new Map<string, { count: number; retryAt: number | null }>();
  /** The request each row waits for, and since when on the monotonic clock. */
  private current = new Map<string, { id: string; since: number }>();
  /** Requests the user answered and the server has not confirmed yet. */
  private answered = new Set<string>();
  /** Threads the user stopped and the server has not confirmed yet. */
  private stopped = new Set<string>();
  /** What went wrong with the last action, by thread id. */
  private errors = new Map<string, string>();
  private details = new Map<string, Details>();
  /** Requests that already flashed. */
  private announced = new Set<string>();
  private showAll = false;
  /** Ticks once per second while the panel is open and something runs. */
  private tickSource = 0;
  /** Waits for the next finished session to lose its row. */
  private expirySource = 0;
  private reported = false;

  /** `gettext` is the one of the extension; a module context has its own (`ctx.t`) only once it runs. */
  constructor(gettext: (text: string) => string) {
    this.name = gettext('T3 Code');
    this.commands = [
      {
        keyword: ['t3'],
        hint: gettext('t3 Fix the failing test'),
        resolve: args => this.resolve(args),
      },
    ];
  }

  enable(ctx: ModuleContext): void {
    this.ctx = ctx;
    this.client = new T3Client(ctx.http, ctx.settings, () => this.safely(() => this.render()));
    ctx.onOpenChanged(open =>
      this.safely(() => {
        if (!open) this.showAll = false;
        this.render();
      }),
    );
    this.client.start();
  }

  disable(): void {
    this.client?.stop();
    this.client = null;
    if (this.tickSource) GLib.source_remove(this.tickSource);
    if (this.expirySource) GLib.source_remove(this.expirySource);
    this.tickSource = this.expirySource = 0;
    this.sessions = [];
    this.prompts.clear();
    this.asking.clear();
    this.failures.clear();
    this.current.clear();
    this.answered.clear();
    this.stopped.clear();
    this.errors.clear();
    this.details.clear();
    this.announced.clear();
    this.showAll = false;
    this.ctx = null;
  }

  // --- the command `t3 <text>` ---

  private resolve(args: string): Result[] {
    const ctx = this.ctx;
    const client = this.client;
    const text = args.trim().slice(0, MAX_REPLY);
    if (!ctx || !client?.connected || !text) return [];
    const _ = ctx.t;
    const target = lastActive(client.shell);
    if (!target) return [];
    const name = truncate(target.title, 32) || _('Untitled thread');
    const results: Result[] = [
      {
        id: 't3:send',
        icon: ICON,
        title: _('Send to %s').replace('%s', name),
        subtitle: truncate(text, 80),
        activate: () => this.reply(target.id, text),
      },
    ];
    if (target.launch) {
      results.push({
        id: 't3:new',
        icon: ICON,
        title: _('Start a new thread'),
        subtitle: [target.project, truncate(text, 80)].filter(Boolean).join(' · '),
        activate: () => this.launch(target, text),
      });
    }
    return results;
  }

  // --- actions ---

  /** Sends a command; a failure shows in the subtitle of the row. */
  private send(threadId: string, promise: Promise<unknown>, undo?: () => void): void {
    this.errors.delete(threadId);
    promise.then(
      () => undefined,
      (error: unknown) =>
        this.safely(() => {
          if (!this.ctx) return;
          undo?.();
          this.errors.set(threadId, truncate(error instanceof Error ? error.message : '', 80));
          this.render();
        }),
    );
  }

  /**
   * A click on Deny or Allow that was rendered for `requestId`. It counts only
   * while the row still waits for that request and has for a moment.
   */
  private respond(
    threadId: string,
    requestId: string | null,
    decision: 'accept' | 'decline',
  ): void {
    const session = this.sessions.find(s => s.id === threadId);
    if (session?.phase !== 'approval' || session.request?.id !== requestId) return;
    // Without the whole command on screen there was nothing to click.
    const prompt = this.prompts.get(session.request.id);
    if (!prompt?.exact) return;
    if (mayAnswer(this.current.get(threadId), requestId, monotonicMs()))
      this.answer(session, decision);
  }

  private answer(session: Session, decision: 'accept' | 'decline'): void {
    const client = this.client;
    const request = session.request;
    if (!client || !request) return;
    // Optimistic: the row runs again until the server says otherwise.
    this.answered.add(request.id);
    this.send(
      session.id,
      client.command(
        respondCommand(GLib.uuid_string_random(), request.threadId, request.id, decision),
      ),
      () => this.answered.delete(request.id),
    );
    this.render();
  }

  private reply(threadId: string, text: string): void {
    const client = this.client;
    if (!client || !text.trim()) return;
    const command = replyCommand(
      GLib.uuid_string_random(),
      GLib.uuid_string_random(),
      threadId,
      text,
    );
    this.send(threadId, client.command(command));
    this.render();
  }

  private stop(session: Session): void {
    const client = this.client;
    if (!client?.descriptor) return;
    const command = stopCommand(GLib.uuid_string_random(), session, client.descriptor);
    if (!command) return;
    this.stopped.add(session.id);
    this.send(session.id, client.command(command), () => this.stopped.delete(session.id));
    this.render();
  }

  private launch(like: Session, text: string): void {
    const client = this.client;
    if (!client) return;
    const payload = launchPayload(
      {
        commandId: GLib.uuid_string_random(),
        threadId: GLib.uuid_string_random(),
        messageId: GLib.uuid_string_random(),
      },
      like,
      text,
    );
    if (payload) this.send(like.id, client.request(METHODS.launchThread, payload));
  }

  private openInApp(threadId: string): void {
    // The desktop app when it is installed, the browser otherwise. The browser
    // has a session of its own and asks for a pairing when it has none.
    const app = Gio.AppInfo.get_default_for_uri_scheme(APP_SCHEME);
    const link = (app && this.client?.appLink(threadId)) || this.client?.link(threadId);
    this.ctx?.close();
    if (!link) return;
    try {
      Gio.AppInfo.launch_default_for_uri(link, global.create_app_launch_context(0, -1));
    } catch {
      // No application for the link; nothing to open then.
    }
  }

  /**
   * Asks what a request is about. An answer that fails, is too large or does
   * not say leaves the command unknown; it is asked for again a few times.
   */
  private fetchPrompt(session: Session, now: number): void {
    const client = this.client;
    const request = session.request;
    if (!client || !request) return;
    const requestId = request.id;
    if (this.prompts.has(requestId) || this.asking.has(requestId)) return;
    const failure = this.failures.get(requestId);
    if (failure && (failure.retryAt === null || now < failure.retryAt)) return;
    const token = {};
    this.asking.set(requestId, token);
    const settle = (prompt: Prompt | null): void =>
      this.safely(() => {
        // Forgotten meanwhile, or asked again: this answer is nobody's.
        if (!this.ctx || this.asking.get(requestId) !== token) return;
        this.asking.delete(requestId);
        if (prompt) {
          this.prompts.set(requestId, prompt);
          this.failures.delete(requestId);
        } else {
          const count = (this.failures.get(requestId)?.count ?? 0) + 1;
          const wait = promptRetryMs(count);
          this.failures.set(requestId, {
            count,
            retryAt: wait === null ? null : Date.now() + wait,
          });
        }
        this.render();
      });
    client.request(METHODS.getThreadProjection, { threadId: request.threadId }).then(
      projection => settle(approvalPrompt(projection, requestId)),
      () => settle(null),
    );
  }

  // --- what is shown ---

  private render(): void {
    const ctx = this.ctx;
    const client = this.client;
    if (!ctx || !client) return;
    const _ = ctx.t;
    const now = Date.now();
    this.sessions = sessionsOf(client.shell, now)
      .filter(session => !this.stopped.has(session.id) || !session.runId)
      .map(session =>
        // An answered request: the session runs again, as far as Visor knows.
        session.request && this.answered.has(session.request.id)
          ? { ...session, phase: 'working' as const, request: null }
          : session,
      );
    this.forget(client);

    const waiting = this.sessions.filter(isWaiting);
    const since = monotonicMs();
    for (const session of waiting) {
      if (session.phase !== 'approval') continue;
      this.fetchPrompt(session, now);
      const requestId = session.request!.id;
      if (this.current.get(session.id)?.id !== requestId)
        this.current.set(session.id, { id: requestId, since });
    }

    if (this.sessions.length === 0) {
      ctx.now.clear();
    } else {
      const { shown, more } = visibleSessions(this.sessions, this.showAll);
      const rows = shown.map(session => this.row(session, now));
      if (more > 0) {
        rows.push({
          id: MORE_ID,
          icon: 'view-more-symbolic',
          title: _('+ %d more').replace('%d', String(more)),
          status: 'done',
          activate: () => {
            this.showAll = true;
            this.render();
          },
        });
      }
      ctx.now.set(rows);
    }

    const first = waiting[0];
    const chip = first ? this.chip(first) : null;
    ctx.peek.set(chip);
    ctx.attention(first ? 'waiting' : null);
    const flash = ctx.settings?.get_boolean(FLASH_KEY) ?? true;
    for (const session of waiting) {
      const requestId = session.request!.id;
      if (this.announced.has(requestId)) continue;
      this.announced.add(requestId);
      if (flash) ctx.peek.flash(this.chip(session));
    }

    this.schedule(now);
  }

  /** Drops what belongs to requests and threads the server no longer has. */
  private forget(client: T3Client): void {
    const prune = <K>(collection: Map<K, unknown> | Set<K>, keep: (key: K) => boolean): void => {
      for (const key of [...collection.keys()]) if (!keep(key)) collection.delete(key);
    };
    const sessions = sessionsOf(client.shell, 0);
    const requests = new Set<string>();
    for (const session of sessions) if (session.request) requests.add(session.request.id);
    const asked = (requestId: string): boolean => requests.has(requestId);
    for (const map of [this.prompts, this.answered, this.announced]) prune(map, asked);
    // What failed is remembered across a connection that broke, or a projection
    // that breaks it would be asked for on every new one.
    if (client.synced) for (const map of [this.asking, this.failures]) prune(map, asked);
    const shown = new Set(this.sessions.map(session => session.id));
    for (const map of [this.current, this.details]) prune(map, id => shown.has(id));
    prune(this.errors, id => client.shell.threads.has(id));
    prune(this.stopped, id => sessions.some(s => s.id === id && s.runId));
  }

  private chip(session: Session): PeekChip {
    const _ = this.ctx!.t;
    const name = truncate(session.title, 20) || _('Agent');
    return {
      icon: ICONS.approval,
      text: _('%s is waiting').replace('%s', name),
      tone: 'waiting',
      priority: 100,
    };
  }

  private state(session: Session, now: number): string {
    const _ = this.ctx!.t;
    switch (session.phase) {
      case 'starting':
        return _('Starting');
      case 'working':
        return session.startedAt === null
          ? _('Working')
          : `${_('Working')} · ${formatDuration(Math.max(0, now - session.startedAt))}`;
      case 'approval':
        if (this.isUnknown(session)) return _('Answer this request in T3 Code');
        if (session.request?.kind === 'command') return _('Wants to run');
        return session.request?.kind === 'file'
          ? _('Wants to use a file')
          : _('Asks for permission');
      case 'question':
        return _('Has a question');
      case 'done':
        return _('Done');
      default:
        return session.error ? `${_('Failed')} · ${session.error}` : _('Failed');
    }
  }

  /** True when asking what an approval is about has failed and nothing is known. */
  private isUnknown(session: Session): boolean {
    const requestId = session.request?.id;
    return requestId !== undefined && !this.prompts.has(requestId) && this.failures.has(requestId);
  }

  private row(session: Session, now: number): NowRow {
    const _ = this.ctx!.t;
    const error = this.errors.get(session.id);
    const state = error ? `${_('Could not send')} · ${error}` : this.state(session, now);
    const row: NowRow = {
      id: `t3:${session.id}`,
      icon: ICONS[session.phase],
      title: session.title || _('Untitled thread'),
      subtitle: [session.project, state].filter(Boolean).join(' · '),
      expand: this.detailsOf(session).expand,
    };
    if (session.phase === 'approval') {
      const requestId = session.request!.id;
      const prompt = this.prompts.get(requestId);
      const waiting: NowRow = {
        ...row,
        status: 'waiting',
        detail: prompt ? promptPreview(prompt) : undefined,
      };
      // Nobody allows what they cannot read. A command that is not known has no
      // buttons, only the way to T3 Code once asking for it has failed; a command
      // the one line cuts off or cannot show is answered next to its full text,
      // if that shows it whole.
      if (!prompt) {
        if (!this.isUnknown(session)) return waiting;
        return {
          ...waiting,
          primary: {
            label: _('Open in T3 Code'),
            style: 'primary',
            run: () => this.openInApp(session.id),
          },
        };
      }
      if (!fitsPreview(prompt)) return waiting;
      return {
        ...waiting,
        controls: [
          {
            label: _('Deny'),
            style: 'ghost',
            run: () => this.respond(session.id, requestId, 'decline'),
          },
        ],
        primary: {
          label: _('Allow'),
          style: 'primary',
          run: () => this.respond(session.id, requestId, 'accept'),
        },
      };
    }
    if (session.phase === 'question') {
      return {
        ...row,
        status: 'waiting',
        primary: { label: _('Answer'), style: 'primary', run: () => this.openInApp(session.id) },
      };
    }
    return session.phase === 'done' ? { ...row, status: 'done' } : row;
  }

  /** The function that builds the expanded part; the same one for the life of the row. */
  private detailsOf(session: Session): Details {
    const threadId = session.id;
    let details = this.details.get(threadId);
    if (!details) {
      const created: Details = {
        message: null,
        stop: null,
        requestId: null,
        showCommand: null,
        expand: () => this.buildDetails(threadId, created),
      };
      this.details.set(threadId, (details = created));
    }
    if (details.message) {
      details.message.text = session.lastMessage;
      details.message.visible = session.lastMessage !== '';
    }
    if (details.stop) details.stop.visible = session.runId !== null;
    details.requestId = session.phase === 'approval' ? (session.request?.id ?? null) : null;
    details.showCommand?.(this.promptOf(session));
    return details;
  }

  /** The command a session waits for, null when it waits for none or it is not known. */
  private promptOf(session: Session | undefined): Prompt | null {
    if (session?.phase !== 'approval' || !session.request) return null;
    return this.prompts.get(session.request.id) ?? null;
  }

  private buildDetails(threadId: string, details: Details): St.Widget {
    const ctx = this.ctx!;
    const _ = ctx.t;
    const session = this.sessions.find(s => s.id === threadId);
    const box = new St.BoxLayout({
      style_class: 'visor-t3-details',
      orientation: Clutter.Orientation.VERTICAL,
      x_expand: true,
    });

    // Plain text: what an agent wrote is never markup.
    const message = new St.Label({
      style_class: 'visor-t3-message',
      text: session?.lastMessage ?? '',
      visible: Boolean(session?.lastMessage),
      x_expand: true,
    });
    message.clutter_text.line_wrap = true;
    message.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
    message.clutter_text.ellipsize = Pango.EllipsizeMode.END;
    box.add_child(message);

    // The whole command, so that what is allowed can be read: it wraps, and
    // after eight lines it ends in an ellipsis and says where the rest is.
    const command = new St.Label({
      style_class: 'visor-t3-command',
      visible: false,
      x_expand: true,
    });
    command.clutter_text.line_wrap = true;
    command.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
    command.clutter_text.ellipsize = Pango.EllipsizeMode.END;
    box.add_child(command);
    const cut = new St.Label({ style_class: 'visor-t3-cut', visible: false });
    box.add_child(cut);
    // Deny and Allow are for a command that is on screen whole and as it runs.
    // That is decided from the text first, and the layout has to agree; until
    // it has been looked at there are no buttons.
    const answers = new St.BoxLayout({ style_class: 'visor-t3-buttons', visible: false });
    const respond = (decision: 'accept' | 'decline'): void => {
      if (answers.visible) this.respond(threadId, details.requestId, decision);
    };
    answers.add_child(
      ctx.kit.button({ label: _('Deny'), style: 'ghost', run: () => respond('decline') }),
    );
    answers.add_child(
      ctx.kit.button({ label: _('Allow'), style: 'primary', run: () => respond('accept') }),
    );
    box.add_child(answers);

    let shown: Prompt | null = null;
    let laidOut: 'unknown' | 'whole' | 'cut' = 'unknown';
    const refresh = (): void => {
      const fits = shown !== null && fitsExpanded(shown);
      const hint = shown !== null && (!fits || laidOut === 'cut');
      const offer = shown !== null && fits && laidOut === 'whole' && !fitsPreview(shown);
      if (hint)
        cut.text = shown?.hidden
          ? _('Has characters that cannot be shown. Open T3 Code to read it')
          : _('Open T3 Code to read all of it');
      if (command.visible !== (shown !== null)) command.visible = shown !== null;
      if (cut.visible !== hint) cut.visible = hint;
      if (answers.visible !== offer) answers.visible = offer;
    };
    // Whether the eight lines were enough is known once the text is laid out.
    let cutSource = 0;
    const look = (): void => {
      if (cutSource) return;
      cutSource = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
        cutSource = 0;
        if (shown === null || !command.has_allocation()) laidOut = 'unknown';
        else laidOut = command.clutter_text.get_layout().is_ellipsized() ? 'cut' : 'whole';
        refresh();
        return GLib.SOURCE_REMOVE;
      });
    };
    command.connect('notify::allocation', look);
    const showCommand = (prompt: Prompt | null): void => {
      if (prompt?.text !== shown?.text) {
        // Another text: what was known about the layout is about the old one.
        laidOut = 'unknown';
        command.text = prompt ? commandLines(prompt.text) : '';
        look();
      }
      shown = prompt;
      refresh();
    };
    showCommand(this.promptOf(session));

    const name = truncate(session?.title ?? '', 24);
    const entry = new St.Entry({
      style_class: 'visor-t3-reply',
      hint_text: name ? _('Reply to %s').replace('%s', name) : _('Reply'),
      accessible_name: _('Reply'),
      can_focus: true,
      x_expand: true,
    });
    entry.clutter_text.max_length = MAX_REPLY;
    entry.clutter_text.connect('activate', () =>
      this.safely(() => {
        const text = entry.get_text().trim();
        if (!text) return;
        entry.set_text('');
        this.reply(threadId, text);
      }),
    );
    box.add_child(entry);

    const buttons = new St.BoxLayout({ style_class: 'visor-t3-buttons' });
    const stop = ctx.kit.button({
      label: _('Stop'),
      style: 'ghost',
      run: () => {
        const current = this.sessions.find(s => s.id === threadId);
        if (current) this.stop(current);
      },
    });
    stop.visible = Boolean(session?.runId);
    buttons.add_child(stop);
    buttons.add_child(
      ctx.kit.button({
        label: _('Open in T3 Code'),
        style: 'ghost',
        run: () => this.openInApp(threadId),
      }),
    );
    box.add_child(buttons);

    details.message = message;
    details.stop = stop;
    details.showCommand = showCommand;
    box.connect('destroy', () => {
      if (cutSource) GLib.source_remove(cutSource);
      cutSource = 0;
      if (details.message !== message) return;
      details.message = details.stop = null;
      details.showCommand = null;
    });
    return box;
  }

  // --- time ---

  private schedule(now: number): void {
    const ctx = this.ctx!;
    const ticking =
      ctx.isOpen && this.sessions.some(s => s.phase === 'working' && s.startedAt !== null);
    if (ticking && !this.tickSource) {
      this.tickSource = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => {
        this.safely(() => this.render());
        return this.tickSource ? GLib.SOURCE_CONTINUE : GLib.SOURCE_REMOVE;
      });
    } else if (!ticking && this.tickSource) {
      GLib.source_remove(this.tickSource);
      this.tickSource = 0;
    }

    if (this.expirySource) GLib.source_remove(this.expirySource);
    this.expirySource = 0;
    // The next finished session to go, or the next command to ask for again.
    const retries = [...this.failures]
      .filter(([requestId]) => !this.asking.has(requestId))
      .map(([, failure]) => failure.retryAt ?? Infinity);
    const next = Math.min(...this.sessions.map(s => s.until ?? Infinity), ...retries);
    if (next === Infinity) return;
    this.expirySource = GLib.timeout_add(
      GLib.PRIORITY_DEFAULT,
      Math.max(50, next - now + 20),
      () => {
        this.expirySource = 0;
        this.safely(() => this.render());
        return GLib.SOURCE_REMOVE;
      },
    );
  }

  /** For callbacks nobody else guards: an exception is logged once and goes no further. */
  private safely(fn: () => void): void {
    try {
      fn();
    } catch (e) {
      if (this.reported) return;
      this.reported = true;
      logError(e as Error, 'Visor: T3 Code');
    }
  }
}

export function t3Module(gettext: (text: string) => string): VisorModule {
  return new T3Module(gettext);
}
