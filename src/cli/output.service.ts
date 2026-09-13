import { Injectable } from '@nestjs/common';

@Injectable()
export class OutputService {
  write(message: string): void {
    process.stdout.write(this.line(message));
  }

  writeError(message: string): void {
    process.stderr.write(this.line(message));
  }

  private line(message: string): string {
    return message.endsWith('\n') ? message : `${message}\n`;
  }
}
