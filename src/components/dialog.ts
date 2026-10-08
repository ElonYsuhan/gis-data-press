/** Imperative bridge for workspace dialogs; visibility and focus are managed by Naive UI. */
export interface DialogHandle {
  showModal(): void
  close(): void
  querySelector<T extends Element = Element>(selector: string): T | null
}
