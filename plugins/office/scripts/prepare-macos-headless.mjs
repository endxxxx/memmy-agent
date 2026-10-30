/** Build a headless-only SAL entry point; keep the vendor renderer libraries. */
import { execFileSync } from 'node:child_process';
import { access, copyFile, rename } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
if (process.platform !== 'darwin') throw new Error('Native macOS worker required');
const root = resolve(process.argv[2]);
const executable = resolve(root, 'LibreOffice.app/Contents/MacOS/soffice');
await access(resolve(root, 'LibreOffice.app/Contents/Frameworks/libmergedlo.dylib'));
await copyFile(executable, executable + '-vendor');
const source = fileURLToPath(new URL('../native/macos-headless.m', import.meta.url));
const built = resolve(root, 'memmy-headless-build');
execFileSync('clang', ['-arch', process.arch === 'x64' ? 'x86_64' : 'arm64', '-O2', '-Wall', '-Wextra', '-framework', 'AppKit',
  '-Wl,-rpath,@executable_path/../Frameworks', source, '-o', built], { stdio: 'inherit' });
// Sign the standalone launcher before placing it inside the vendor bundle;
// codesign otherwise attempts to validate unrelated vendor helper resources.
execFileSync('codesign', ['--force', '--sign', '-', built], { stdio: 'inherit' });
await rename(built, executable);
await copyFile(source, resolve(root, 'macos-headless.m'));
execFileSync(executable, ['--headless', '--version'], { stdio: 'inherit', timeout: 30000 });
console.log('Prepared headless-only macOS renderer entry point');
