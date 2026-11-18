import base64
import datetime
import hashlib
import json
import os
from pathlib import Path
import plistlib
import shutil
import subprocess
import sys


def run(*args, **kwargs):
    return subprocess.run(args, check=True, capture_output=True, **kwargs).stdout


os.umask(0o077)
root = Path(os.environ['RUNNER_TEMP']) / 'cohub-apple-signing'
installed_file = root / 'installed-profiles.json'
if '--cleanup' in sys.argv:
    if installed_file.exists():
        for profile in json.loads(installed_file.read_text()):
            Path(profile).unlink(missing_ok=True)
    shutil.rmtree(root, ignore_errors=True)
    sys.exit(0)

team = os.environ['APPLE_TEAM_ID']
platform = os.environ['APPLE_PLATFORM']
assert platform in ['ios', 'macos'], 'Unsupported Apple platform'
identities = json.loads(os.environ['APPLE_SIGNING_IDENTITIES'])
assert len(identities) == 1, 'Expected one imported application signing identity'
outputs = {'identity': identities[0]['hash']}
root.mkdir(mode=0o700)
profiles = [('profile', 'APPLE_PROFILE')]
if platform == 'ios':
    profiles.append(('share-profile', 'APPLE_SHARE_PROFILE'))
installed = []
for name, variable in profiles:
    profile = root / (name + '.mobileprovision')
    profile.write_bytes(base64.b64decode(os.environ[variable], validate=True))
    data = plistlib.loads(run('security', 'cms', '-D', '-i', str(profile)))
    entitlements = data['Entitlements']
    bundle = 'live.cohub.ios' + ('.share' if name == 'share-profile' else '')
    assert ('iOS' if platform == 'ios' else 'OSX') in data['Platform'], 'Wrong provisioning platform'
    assert data['TeamIdentifier'] == [team], 'Provisioning profile belongs to another team'
    assert data['ExpirationDate'] > datetime.datetime.now(datetime.timezone.utc).replace(tzinfo=None), 'Provisioning profile has expired'
    assert not data.get('ProvisionedDevices') and not data.get('ProvisionsAllDevices'), 'An App Store profile is required'
    assert not entitlements.get('get-task-allow', False), 'Development signing is not allowed'
    assert outputs['identity'] in [hashlib.sha1(cert).hexdigest().upper() for cert in data['DeveloperCertificates']], 'Profile does not include the imported signing identity'
    assert entitlements.get('application-identifier', entitlements.get('com.apple.application-identifier')) == team + '.' + bundle, 'Unexpected application identifier'
    if platform == 'ios':
        assert entitlements.get('com.apple.security.application-groups') == ['group.live.cohub.ios'], 'Missing iOS App Group'
    if name == 'profile':
        assert 'com.apple.developer.associated-domains' in entitlements, 'Sign-in requires Associated Domains'
    directory = Path.home() / 'Library/Developer/Xcode/UserData/Provisioning Profiles'
    directory.mkdir(parents=True, exist_ok=True)
    destination = directory / (data['UUID'] + ('.provisionprofile' if platform == 'macos' else '.mobileprovision'))
    assert not destination.exists(), 'Refusing to overwrite a provisioning profile'
    installed.append(str(destination))
    installed_file.write_text(json.dumps(installed))
    destination.write_bytes(profile.read_bytes())
    outputs[name] = data['UUID']
    outputs[name + '-path'] = str(profile)
    print('Installed ' + data['Name'])

if platform == 'ios':
    options = plistlib.loads(Path('apps/ios/ExportOptions.plist').read_bytes())
    options.update(teamID=team, signingCertificate=outputs['identity'], provisioningProfiles={
        'live.cohub.ios': outputs['profile'], 'live.cohub.ios.share': outputs['share-profile'],
    })
    path = root / 'ExportOptions.plist'
    path.write_bytes(plistlib.dumps(options))
    outputs['export-options'] = str(path)
else:
    pem = run('security', 'find-certificate', '-c', '3rd Party Mac Developer Installer:', '-p', 'signing_temp.keychain')
    subject = run('openssl', 'x509', '-noout', '-subject', '-nameopt', 'sep_multiline', input=pem).decode()
    outputs['installer-identity'] = next(line.strip()[3:] for line in subject.splitlines() if line.strip().startswith('CN='))

with open(os.environ['GITHUB_OUTPUT'], 'a') as output:
    for key, value in outputs.items():
        output.write(key + '=' + value + '\n')
