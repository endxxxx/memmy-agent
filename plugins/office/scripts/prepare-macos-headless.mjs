/** Build a headless-only SAL entry point; keep the vendor renderer libraries. */
import { execFileSync } from 'node:child_process';
import { access, copyFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
if (process.platform !== 'darwin') throw new Error('Native macOS worker required');
const root = resolve(process.argv[2]);
const executable = resolve(root, 'LibreOffice.app/Contents/MacOS/soffice');
await access(resolve(root, 'LibreOffice.app/Contents/Frameworks/libmergedlo.dylib'));
await copyFile(executable, executable + '-vendor');
const source = fileURLToPath(new URL('../native/macos-headless.m', import.meta.url));
execFileSync('clang', ['-arch', process.arch === 'x64' ? 'x86_64' : 'arm64', '-O2', '-Wall', '-Wextra', '-framework', 'AppKit',
  '-Wl,-rpath,@executable_path/../Frameworks', source, '-o', executable], { stdio: 'inherit' });
execFileSync('codesign', ['--force', '--sign', '-', executable], { stdio: 'inherit' });
await copyFile(source, resolve(root, 'macos-headless.m'));
console.log('Prepared headless-only macOS renderer entry point');
