"""Recover a previously built runtime tree after checking every archive entry."""
import hashlib,json,os,sys,zipfile
from pathlib import Path
source=Path(sys.argv[1]);root=Path(sys.argv[2]);target=sys.argv[3]
pointer=next(source.rglob('office-runtime-'+target+'.json'))
d=json.loads(pointer.read_text());archive=pointer.parent/d['archive']['url']
h=hashlib.sha256()
with archive.open('rb') as f:
    while b:=f.read(4*1024*1024):h.update(b)
assert h.hexdigest()==d['archive']['sha256']
assert archive.stat().st_size==d['archive']['bytes']
root.mkdir()
with zipfile.ZipFile(archive) as z:
    assert set(z.namelist())==set(d['files'])
    for info in z.infolist():
        name=info.filename
        assert not name.startswith('/') and all(p not in ['.','..',''] for p in name.split('/'))
        b=z.read(info);assert hashlib.sha256(b).hexdigest()==d['files'][name]
        path=root/name;path.parent.mkdir(parents=True,exist_ok=True);path.write_bytes(b)
        path.chmod(0o755 if ((info.external_attr>>16)&0o111) else 0o644)
print('Verified and extracted',target)
