import {
  Container,
  Text,
  type Component,
  type Focusable,
  type TUI,
} from "@earendil-works/pi-tui";
import { SecretInput } from "../../auth/secret-input.js";

/**
 * Single-line visible input dialog, used for entering file system paths.
 * Mirrors LoginDialog but does not mask the typed value.
 */
export class PathInputDialog extends Container implements Component, Focusable {
  private readonly input: SecretInput;
  private _focused = false;
  private resolveInput?: (value: string | undefined) => void;

  constructor(
    private readonly tui: TUI,
    title: string,
    private readonly accent: (text: string) => string,
    private readonly muted: (text: string) => string,
    description: string[] = [],
  ) {
    super();
    this.input = new SecretInput({ label: "path:", masked: false });
    this.input.onSubmit = (value) => this.resolveInput?.(value);
    this.input.onEscape = () => this.resolveInput?.(undefined);

    this.addChild(
      new Text(
        [
          accent(`  ${title}`),
          ...description.map((line) => muted(`  ${line}`)),
          "",
        ].join("\n"),
        0,
        1,
      ),
    );
    this.addChild(this.input);
    this.addChild(new Text(muted("  Enter to confirm   Esc to cancel"), 0, 1));
  }

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
    this.input.focused = value;
  }

  handleInput(data: string): void {
    this.input.handleInput(data);
    this.tui.requestRender();
  }

  open(): Promise<string | undefined> {
    return new Promise((resolve) => {
      this.resolveInput = (value) => {
        this.resolveInput = undefined;
        resolve(value);
      };
    });
  }
}
