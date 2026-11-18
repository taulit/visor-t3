// libsecret, as far as src/keyring.ts uses it (no @girs package is installed for it).
// A file of its own: ambient.d.ts has imports, so it cannot declare a new module.
declare module 'gi://Secret' {
  import type Gio from 'gi://Gio';

  namespace Secret {
    enum SchemaFlags {
      NONE,
    }
    enum SchemaAttributeType {
      STRING,
    }
    class Schema {
      constructor(
        name: string,
        flags: SchemaFlags,
        attributes: Record<string, SchemaAttributeType>,
      );
    }
    class Service {
      static disconnect(): void;
    }
    const COLLECTION_DEFAULT: string;
    type Attributes = Record<string, string>;
    type Callback = (source: unknown, result: Gio.AsyncResult) => void;
    function password_store(
      schema: Schema,
      attributes: Attributes,
      collection: string | null,
      label: string,
      password: string,
      cancellable: Gio.Cancellable | null,
      callback: Callback,
    ): void;
    function password_store_finish(result: Gio.AsyncResult): boolean;
    function password_lookup(
      schema: Schema,
      attributes: Attributes,
      cancellable: Gio.Cancellable | null,
      callback: Callback,
    ): void;
    function password_lookup_finish(result: Gio.AsyncResult): string | null;
    function password_clear(
      schema: Schema,
      attributes: Attributes,
      cancellable: Gio.Cancellable | null,
      callback: Callback,
    ): void;
    function password_clear_finish(result: Gio.AsyncResult): boolean;
  }
  export default Secret;
}
