import {
  Container,
  Text,
  type Component,
  type Focusable,
  type TUI,
} from "@earendil-works/pi-tui";
import { SecretInput } from "./secret-input.js";

export class LoginDialog extends Container implements Component, Focusable {
  private readonly input: SecretInput;
  private _focused = false;
  private resolveLogin?: (value: string | undefined) => void;

  constructor(
    private readonly tui: TUI,
    providerName: string,
    private readonly accent: (text: string) => string,
    private readonly muted: (text: string) => string,
  ) {
    super();
    this.input = new SecretInput();
    this.input.onSubmit = (value) => this.resolveLogin?.(value);
    this.input.onEscape = () => this.resolveLogin?.(undefined);

    this.addChild(
      new Text(
        [
          accent(`  Login to ${providerName}`),
          muted("  The key is stored locally in your CityBrain user config."),
          "",
        ].join("\n"),
        0,
        1,
      ),
    );
    this.addChild(this.input);
    this.addChild(new Text(muted("  Enter to save   Esc to cancel"), 0, 1));
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
      this.resolveLogin = (value) => {
        this.resolveLogin = undefined;
        resolve(value);
      };
    });
  }
}
