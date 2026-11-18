import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';
import {
  ExtensionPreferences,
  gettext as _,
} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import { pairingGroup } from './pairing-group.js';

const VISOR_UUID = 'visor@taulit.github.io';
// Search for Visor in the extension store. Replace it with the page of Visor once you know it.
const VISOR_STORE_URL = 'https://extensions.gnome.org/?search=visor';

/** True when the shell knows the extension (installed, enabled or not). */
async function isInstalled(uuid: string): Promise<boolean> {
  const reply = await new Promise<GLib.Variant>((resolve, reject) => {
    Gio.DBus.session.call(
      'org.gnome.Shell',
      '/org/gnome/Shell',
      'org.gnome.Shell.Extensions',
      'GetExtensionInfo',
      new GLib.Variant('(s)', [uuid]),
      null,
      Gio.DBusCallFlags.NONE,
      -1,
      null,
      (connection, result) => {
        try {
          resolve(connection!.call_finish(result));
        } catch (e) {
          reject(e);
        }
      },
    );
  });
  // The shell answers with an empty dictionary for an unknown extension.
  const [info] = reply.deepUnpack<[Record<string, unknown>]>();
  return Object.keys(info).length > 0;
}

export default class T3CodePreferences extends ExtensionPreferences {
  override async fillPreferencesWindow(window: Adw.PreferencesWindow): Promise<void> {
    const page = new Adw.PreferencesPage({
      title: _('General'),
      icon_name: 'emblem-system-symbolic',
    });
    window.add(page);

    // Visor is a separate extension. Without it this module does nothing, so say so.
    const hint = new Adw.PreferencesGroup({ visible: false });
    const row = new Adw.ActionRow({
      title: _('Visor is not installed'),
      subtitle: _('This module needs Visor and does nothing without it.'),
    });
    row.add_suffix(
      new Gtk.LinkButton({ label: _('Get Visor'), uri: VISOR_STORE_URL, valign: Gtk.Align.CENTER }),
    );
    hint.add(row);
    page.add(hint);

    const settings = this.getSettings();
    page.add(pairingGroup(settings, window));

    const behavior = new Adw.PreferencesGroup({ title: _('Behavior') });
    const flash = new Adw.SwitchRow({ title: _('Show briefly when an agent is waiting') });
    settings.bind('flash-on-waiting-agents', flash, 'active', Gio.SettingsBindFlags.DEFAULT);
    behavior.add(flash);
    page.add(behavior);

    try {
      hint.visible = !(await isInstalled(VISOR_UUID));
    } catch (e) {
      // The shell did not answer; show no hint rather than a wrong one.
      console.warn(`${this.uuid}: could not ask the shell about Visor: ${e}`);
    }
  }
}
