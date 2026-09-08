import pc from "picocolors";

export class Spinner {
  private animationFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  private timer: NodeJS.Timeout | null = null;
  private currentFrameIndex = 0;
  private statusText: string;

  constructor(initialText: string) {
    this.statusText = initialText;
  }

  start() {
    if (this.timer || !process.stdout.isTTY) return;
    process.stdout.write("\x1B[?25l"); // Hide the cursor during animation.
    this.timer = setInterval(() => {
      const currentSymbol = pc.cyan(this.animationFrames[this.currentFrameIndex]);
      process.stdout.write(`\r ${currentSymbol} ${this.statusText}`);
      this.currentFrameIndex = (this.currentFrameIndex + 1) % this.animationFrames.length;
    }, 80);
  }

  updateText(newText: string) {
    this.statusText = newText;
  }

  stop(isSuccess = true, finalText?: string) {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (process.stdout.isTTY) process.stdout.write("\x1B[?25h"); // Restore the cursor.
    const statusIcon = isSuccess ? pc.green("✔") : pc.red("✖");
    const completionMessage = finalText || this.statusText;
    process.stdout.write(`\r ${statusIcon} ${completionMessage}\n`);
  }
}
