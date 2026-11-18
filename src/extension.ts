import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';

import { t3Module } from './module.js';
import { connectVisor, type VisorConnection } from './visor/connect.js';

export default class T3CodeModule extends Extension {
  private connection: VisorConnection | null = null;

  override enable(): void {
    // Registers the module when Visor is active, now or later, and again when Visor
    // comes back after it was disabled. Does nothing when Visor is not installed.
    this.connection = connectVisor(
      this,
      t3Module(s => this.gettext(s)),
    );
  }

  override disable(): void {
    this.connection?.disconnect();
    this.connection = null;
  }
}
