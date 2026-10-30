"""Release worker: collect a relocatable Ubuntu 24.04+ LibreOffice/Poppler tree."""
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys

root = Path(sys.argv[1]).resolve()
root.mkdir(exist_ok=False)
for name in ['bin', 'lib', 'libexec', 'etc', 'licenses', 'share/fonts']:
    (root / name).mkdir(parents=True, exist_ok=True)
shutil.copytree('/usr/lib/libreoffice', root / 'LibreOffice', symlinks=False)
# Debian's LibreOffice tree links resources into /usr/share; dereferencing above
# retains the actual resources. All subsequently packaged entries are regular files.
for source in Path('/usr/share/fonts').glob('*'):
    if source.is_dir():
        shutil.copytree(source, root / 'share/fonts' / source.name, symlinks=False)
for tool in ['pdfinfo', 'pdftoppm', 'pdftotext']:
    shutil.copy2(shutil.which(tool), root / 'libexec' / tool)

def elf(path):
    with path.open('rb') as stream:
        return stream.read(4) == b'\x7fELF'

# Keep only the host's glibc/loader ABI as an external dependency. Everything
# else discovered by ldd, including libraries loaded by LibreOffice modules,
# is collected recursively, including modules not reached by soffice.bin alone.
system = re.compile(r'^(ld-linux.*|lib(c|m|pthread|dl|rt|resolv|util|anl|nss_.*)\.so(?:\..*)?)$')
queue = [p for p in root.rglob('*') if p.is_file() and elf(p)]
seen = set()
while queue:
    binary = queue.pop()
    if binary in seen:
        continue
    seen.add(binary)
    result = subprocess.run(['ldd', str(binary)], capture_output=True, text=True)
    for line in result.stdout.splitlines():
        if 'not found' in line:
            raise RuntimeError(f'Unresolved build dependency: {binary}: {line}')
        match = re.search(r'=> (/\S+)', line)
        if not match:
            continue
        source = Path(match[1])
        if system.match(source.name):
            continue
        target = root / 'lib' / source.name
        if not target.exists():
            shutil.copy2(source, target, follow_symlinks=True)
            queue.append(target)
        elif hashlib.sha256(source.read_bytes()).digest() != hashlib.sha256(target.read_bytes()).digest():
            raise RuntimeError(f'Conflicting library basename: {source.name}')

for binary in seen:
    # Each module can resolve both its siblings and collected transitive libs.
    lib = os.path.relpath(root / 'lib', binary.parent)
    program = os.path.relpath(root / 'LibreOffice/program', binary.parent)
    subprocess.run(['patchelf', '--set-rpath', f'$ORIGIN:$ORIGIN/{lib}:$ORIGIN/{program}', str(binary)], check=True)

(root / 'etc/fonts.conf').write_text('''<?xml version="1.0"?>
<!DOCTYPE fontconfig SYSTEM "urn:fontconfig:fonts.dtd">
<fontconfig><dir prefix="relative">../share/fonts</dir>
<cachedir prefix="xdg">fontconfig</cachedir></fontconfig>
''')
tools = {}
for tool in ['soffice', 'pdfinfo', 'pdftoppm', 'pdftotext']:
    command = 'LibreOffice/program/soffice' if tool == 'soffice' else f'libexec/{tool}'
    wrapper = root / 'bin' / tool
    wrapper.write_text('#!/bin/sh\n'
        'ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)\n'
        'export LD_LIBRARY_PATH="$ROOT/lib:$ROOT/LibreOffice/program"\n'
        'export FONTCONFIG_FILE="$ROOT/etc/fonts.conf"\n'
        'export SAL_USE_VCLPLUGIN=gen\n'
        f'exec "$ROOT/{command}" "$@"\n')
    wrapper.chmod(0o755)
    tools[tool] = 'bin/' + tool
for p in Path('/usr/share/doc').iterdir():
    if (p / 'copyright').exists():
        shutil.copy2(p / 'copyright', root / 'licenses' / (p.name + '.copyright'))
(root / 'BUILD-INPUTS.txt').write_text(subprocess.check_output(['dpkg-query', '-W'], text=True))
(root / 'README.txt').write_text('Native Ubuntu 24.04 build. Requires Linux with glibc >= 2.39 and /bin/sh.\n'
    'LibreOffice, Poppler, fonts and non-glibc shared dependencies are bundled.\n')
(root / 'runtime-tools.json').write_text(json.dumps(tools, indent=2))
print(json.dumps({'root': str(root), 'elfFiles': len(seen), 'tools': tools}))
