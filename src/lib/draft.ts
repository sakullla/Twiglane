export class DraftBuffer {
  path: string | null = null;
  private pending: string | null = null;

  load(path: string, _value: string): void {
    this.path = path;
    this.pending = null;
  }

  edit(value: string): void {
    this.pending = value;
  }

  peek(path: string): string | null {
    if (this.path !== path) return null;
    return this.pending;
  }

  takePending(path: string): string | null {
    if (this.path !== path) return null;
    const value = this.pending;
    this.pending = null;
    return value;
  }
}
