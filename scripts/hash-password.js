import { createPasswordHash } from '../src/security.js';
import { stdin, stdout } from 'node:process';
import { Writable } from 'node:stream';
import { createInterface } from 'node:readline/promises';

async function readPassword() {
  if (process.env.ADMIN_PASSWORD) return process.env.ADMIN_PASSWORD;
  if (!stdin.isTTY) {
    let value = '';
    for await (const chunk of stdin) value += chunk;
    return value.replace(/\r?\n$/, '');
  }

  class MutedOutput extends Writable {
    muted = false;

    _write(chunk, encoding, callback) {
      if (!this.muted) stdout.write(chunk, encoding);
      callback();
    }
  }

  const output = new MutedOutput();
  const prompt = createInterface({ input: stdin, output, terminal: true });
  stdout.write('رمز مدیر را وارد کنید (نمایش داده نمی‌شود): ');
  output.muted = true;
  try {
    return await prompt.question('');
  } finally {
    output.muted = false;
    prompt.close();
    stdout.write('\n');
  }
}

if (process.argv.length > 2) {
  console.error('رمز را در آرگومان فرمان قرار ندهید؛ npm run hash-password را بدون آرگومان اجرا کنید.');
  process.exitCode = 1;
} else {
  try {
    const password = await readPassword();
    if (!password) throw new Error('رمز عبور خالی است.');
    stdout.write(`${createPasswordHash(password)}\n`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
