import pc from "picocolors";

export class Spinner {
  private frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  private timer: NodeJS.Timeout | null = null;
  private currentFrame = 0;
  private text: string;

  constructor(text: string) {
    this.text = text;
  }

  start() {
    process.stdout.write("\x1B[?25l"); // Ocultar cursor
    this.timer = setInterval(() => {
      const frame = pc.cyan(this.frames[this.currentFrame]);
      process.stdout.write(`\r ${frame} ${this.text}`);
      this.currentFrame = (this.currentFrame + 1) % this.frames.length;
    }, 80);
  }

  updateText(text: string) {
    this.text = text;
  }

  stop(success = true, finalText?: string) {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    process.stdout.write("\x1B[?25h"); // Restaurar cursor
    const icon = success ? pc.green("✔") : pc.red("✖");
    const msg = finalText || this.text;
    process.stdout.write(`\r ${icon} ${msg}\n`);
  }
}
