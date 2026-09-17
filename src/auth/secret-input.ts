import {
  CURSOR_MARKER,
  getKeybindings,
  type Component,
  type Focusable,
} from "@earendil-works/pi-tui";

export interface SecretInputOptions {
  /** Text shown before the input value. */
  label?: string;
  /** Mask typed characters. Defaults to true. */
  masked?: boolean;
}

export class SecretInput implements Component, Focusable {
  private value = "";
  private cursor = 0;
  private _focused = false;
  private pasteBuffer = "";
  private isInPaste = false;

  constructor(private readonly options: SecretInputOptions = {}) {}

  onSubmit?: (value: string) => void;
  onEscape?: () => void;

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
  }

  getValue(): string {
    return this.value;
  }

  handleInput(data: string): void {
    const pasteStart = "\u001b[200~";
    const pasteEnd = "\u001b[201~";

    const pasteStartIndex = data.indexOf(pasteStart);
    if (pasteStartIndex !== -1) {
      this.isInPaste = true;
      this.pasteBuffer = data.slice(pasteStartIndex + pasteStart.length);
      data = "";
    }

    if (this.isInPaste) {
      this.pasteBuffer += data;
      const pasteEndIndex = this.pasteBuffer.indexOf(pasteEnd);
      if (pasteEndIndex === -1) {
        return;
      }

      const pastedText = this.pasteBuffer.slice(0, pasteEndIndex).replace(/[\r\n]/gu, "");
      this.insertText(pastedText);

      const remaining = this.pasteBuffer.slice(pasteEndIndex + pasteEnd.length);
      this.pasteBuffer = "";
      this.isInPaste = false;
      if (remaining) {
        this.handleInput(remaining);
      }
      return;
    }

    const keybindings = getKeybindings();

    if (keybindings.matches(data, "tui.select.cancel")) {
      this.onEscape?.();
      return;
    }
    if (keybindings.matches(data, "tui.input.submit") || data === "\n") {
      this.onSubmit?.(this.value);
      return;
    }
    if (keybindings.matches(data, "tui.editor.deleteCharBackward")) {
      if (this.cursor > 0) {
        this.value = this.value.slice(0, this.cursor - 1) + this.value.slice(this.cursor);
        this.cursor -= 1;
      }
      return;
    }
    if (keybindings.matches(data, "tui.editor.deleteCharForward")) {
      if (this.cursor < this.value.length) {
        this.value = this.value.slice(0, this.cursor) + this.value.slice(this.cursor + 1);
      }
      return;
    }
    if (keybindings.matches(data, "tui.editor.cursorLeft")) {
      this.cursor = Math.max(0, this.cursor - 1);
      return;
    }
    if (keybindings.matches(data, "tui.editor.cursorRight")) {
      this.cursor = Math.min(this.value.length, this.cursor + 1);
      return;
    }
    if (keybindings.matches(data, "tui.editor.cursorLineStart")) {
      this.cursor = 0;
      return;
    }
    if (keybindings.matches(data, "tui.editor.cursorLineEnd")) {
      this.cursor = this.value.length;
      return;
    }

    this.insertText(data);
  }

  private insertText(text: string): void {
    for (const character of text) {
      if (character >= " " && character !== "\u007f") {
        this.value = this.value.slice(0, this.cursor) + character + this.value.slice(this.cursor);
        this.cursor += 1;
      }
    }
  }

  invalidate(): void {}

  render(_width: number): string[] {
    const label = this.options.label ?? "API key:";
    const display = this.options.masked === false
      ? this.value
      : "*".repeat([...this.value].length);
    const beforeCursor = [...display].slice(0, this.cursor).join("");
    const afterCursor = [...display].slice(this.cursor).join("");
    const cursor = this._focused ? CURSOR_MARKER : "";
    return [`  ${label} ${beforeCursor}${cursor}${afterCursor}`];
  }
}
