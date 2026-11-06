/**
 * Incremental terminal-transcript filter.
 *
 * The raw PTY log keeps every byte; this filter turns the live byte stream into
 * the model-facing transcript that is appended to the filtered log. It is
 * deliberately incremental: bytes are decoded with a persistent UTF-8 decoder and
 * escape sequences are parsed as a state machine, so a sequence or a multibyte
 * character split across two reads is handled without rescanning or dropping the
 * command text the terminal actually showed.
 *
 * - ANSI CSI, OSC and the other two-byte escapes are removed.
 * - C0 controls other than newline, carriage return, backspace and tab are
 *   removed; backspace deletes the character it would erase.
 * - A carriage return overwrites the current line, so progress bars collapse to
 *   their final state; `\r\n` is one newline.
 * - Text without a newline is emitted by `flush()` when the stream goes quiet, so
 *   an interactive prompt is visible without waiting for a newline. Once flushed,
 *   that text is no longer overwritable: a later carriage return can only collapse
 *   a line that is still buffered.
 */

import { StringDecoder } from "node:string_decoder";

type State = "text" | "escape" | "escape-final" | "csi" | "osc" | "osc-escape";

const ESC = "\u001b";
const BEL = "\u0007";

export class OutputFilter {
  #decoder = new StringDecoder("utf8");
  #state: State = "text";
  /** The current line, not yet emitted. */
  #line = "";
  /** The line a carriage return overwrote, kept until the next character. */
  #returned = "";
  #afterReturn = false;
  #pending = "";

  /** Feed raw bytes; returns the transcript text that is ready to append. */
  write(chunk: Buffer): string {
    return this.#text(this.#decoder.write(chunk));
  }

  /** Emit text that is still waiting for a newline, as the stream has gone quiet. */
  flush(): string {
    if (this.#afterReturn) {
      this.#line = this.#returned;
      this.#returned = "";
      this.#afterReturn = false;
    }
    if (this.#line !== "") {
      this.#pending += this.#line;
      this.#line = "";
    }
    return this.#take();
  }

  #take(): string {
    const text = this.#pending;
    this.#pending = "";
    return text;
  }

  #newline(): void {
    const line = this.#afterReturn ? this.#returned : this.#line;
    this.#pending += `${line}\n`;
    this.#line = "";
    this.#returned = "";
    this.#afterReturn = false;
  }

  #text(input: string): string {
    for (const char of input) {
      switch (this.#state) {
        case "escape":
          this.#state = this.#escape(char);
          break;
        case "escape-final":
          this.#state = "text";
          break;
        case "csi":
          if (char >= "\u0040" && char <= "\u007e") this.#state = "text";
          break;
        case "osc":
          if (char === BEL) this.#state = "text";
          else if (char === ESC) this.#state = "osc-escape";
          break;
        case "osc-escape":
          this.#state = char === "\\" ? "text" : "osc";
          break;
        default:
          this.#visible(char);
          break;
      }
    }
    return this.#take();
  }

  #escape(char: string): State {
    if (char === "[") return "csi";
    if (char === "]" || char === "P" || char === "^" || char === "_") return "osc";
    // Charset and other designated sequences carry one final byte.
    if (char === "(" || char === ")" || char === "#" || char === "%") return "escape-final";
    return "text";
  }

  #visible(char: string): void {
    if (char === ESC) {
      this.#state = "escape";
      return;
    }
    if (this.#afterReturn) {
      if (char === "\n") {
        this.#newline();
        return;
      }
      // The carriage return overwrote the previous line: it is gone.
      this.#returned = "";
      this.#afterReturn = false;
    }
    switch (char) {
      case "\n":
        this.#newline();
        return;
      case "\r":
        this.#returned = this.#line;
        this.#line = "";
        this.#afterReturn = true;
        return;
      case "\b":
        this.#line = [...this.#line].slice(0, -1).join("");
        return;
      case "\t":
        this.#line += char;
        return;
      default:
        break;
    }
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return;
    this.#line += char;
  }
}
