"""Verify Linux startup under the Host's filesystem isolation before packaging."""
import os
from pathlib import Path
import subprocess
import sys

root = Path(sys.argv[1]).resolve()
work = Path(sys.argv[2]).resolve()
work.mkdir()
source = work / 'smoke.txt'
source.write_text('Office portable renderer: native relocation test.\n')
for name in ['fundamentalrc', 'unorc', 'bootstraprc']:
    path = root / 'LibreOffice/program' / name
    print(str(path), path.read_text() if path.exists() else 'MISSING', flush=True)
args = ['strace', '-f', '-e', 'trace=file', '-o', str(work / 'files.trace'),
        'bwrap', '--die-with-parent', '--unshare-all', '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp']
for path in ['/usr', '/bin', '/lib', '/lib64']:
    args += ['--ro-bind-try', path, path]
args += ['--ro-bind', str(root), str(root), '--bind', str(work), str(work), '--chdir', str(work),
         '--', str(root / 'bin/soffice'), '-env:UserInstallation=' + (work / 'profile').as_uri(),
         '--headless', '--convert-to', 'pdf', '--outdir', str(work), str(source)]
env = dict(os.environ, HOME=str(work), TMPDIR=str(work))
result = subprocess.run(args, env=env, text=True, capture_output=True, timeout=90)
print(result.stdout, flush=True)
print(result.stderr, flush=True)
if result.returncode or not (work / 'smoke.pdf').is_file():
    lines = (work / 'files.trace').read_text().splitlines()
    relevant = [line for line in lines if 'ENOENT' in line or 'EACCES' in line]
    print('\n'.join(relevant[-100:]), flush=True)
    raise RuntimeError('Relocated Linux renderer failed: ' + str(result.returncode))
print('Linux relocated sandbox smoke passed', flush=True)
