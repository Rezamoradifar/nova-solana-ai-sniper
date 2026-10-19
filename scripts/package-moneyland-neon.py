"""Package tracked source and built UI, excluding secrets and font binaries."""
from pathlib import Path
import subprocess
import zipfile

root = Path(__file__).resolve().parents[1]
out = root / 'moneyland-deliverables'
out.mkdir(exist_ok=True)
font_suffixes = {'.ttf', '.otf', '.woff', '.woff2', '.eot', '.pfb', '.pfa'}

def allowed(path: Path) -> bool:
    return path.suffix.lower() not in font_suffixes and path.name != '.env' and '.git' not in path.parts

tracked = subprocess.check_output(['git', 'ls-files', '-z'], cwd=root).decode().split('\0')
with zipfile.ZipFile(out / 'moneyland-neon-source.zip', 'w', zipfile.ZIP_DEFLATED) as z:
    for rel in tracked:
        path = root / rel
        if rel and path.is_file() and allowed(path):
            z.write(path, rel)
    z.writestr('DELIVERY-NOTE.txt', 'Font binaries and runtime secrets are not included. See docs/MONEYLAND_NEON_HANDOFF.md for frontend setup.\n')

dist = root / 'apps/dashboard/dist'
if dist.exists():
    with zipfile.ZipFile(out / 'moneyland-neon-built-ui.zip', 'w', zipfile.ZIP_DEFLATED) as z:
        for path in dist.rglob('*'):
            if path.is_file() and allowed(path):
                z.write(path, path.relative_to(dist))

handoff = root / 'docs/MONEYLAND_NEON_HANDOFF.md'
if handoff.exists():
    (out / handoff.name).write_text(handoff.read_text())
