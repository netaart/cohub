import json
import os
from pathlib import Path
import shutil
import subprocess

root = Path(os.environ['RUNNER_TEMP']) / 'cohub-apple-signing'
if root.exists():
    previous = root / 'previous-keychains.json'
    if previous.exists():
        subprocess.run(['security', 'list-keychains', '-d', 'user', '-s', *json.loads(previous.read_text())], check=True)
    keychain = root / 'signing.keychain-db'
    if keychain.exists():
        subprocess.run(['security', 'delete-keychain', str(keychain)], check=True)
    installed = root / 'installed-profiles.json'
    if installed.exists():
        for profile in json.loads(installed.read_text()):
            Path(profile).unlink(missing_ok=True)
    shutil.rmtree(root)
