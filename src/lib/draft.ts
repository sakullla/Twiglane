import { checkoutKey } from "./workspaces";

interface UnsavedDraft {
  value: string;
  pending: string | null;
}

/** Only unacknowledged local edits live here. Saved drafts are owned by the native store. */
export class DraftBuffer {
  path: string | null = null;
  private unsaved = new Map<string, UnsavedDraft>();

  load(path: string): void { this.path = path; }
  unload(): void { this.path = null; }

  edit(value: string): void {
    if (this.path === null) return;
    this.unsaved.set(checkoutKey(this.path), { value, pending: value });
  }

  peek(path: string): string | null {
    return this.unsaved.get(checkoutKey(path))?.value ?? null;
  }

  takePending(path: string): string | null {
    const record = this.unsaved.get(checkoutKey(path));
    if (!record) return null;
    const value = record.pending;
    record.pending = null;
    return value;
  }

  saved(path: string, message: string): void {
    const key = checkoutKey(path);
    const record = this.unsaved.get(key);
    if (record?.value === message && record.pending === null) this.unsaved.delete(key);
  }

  failed(path: string, message: string): void {
    const key = checkoutKey(path);
    const record = this.unsaved.get(key);
    if (!record) this.unsaved.set(key, { value: message, pending: message });
    else if (record.value === message && record.pending === null) record.pending = message;
  }

  clear(path: string): void { this.unsaved.delete(checkoutKey(path)); }
}
