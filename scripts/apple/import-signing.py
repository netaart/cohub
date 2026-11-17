import base64
import datetime
import hashlib
import json
import os
from pathlib import Path
import plistlib
import secrets
import subprocess


def run(*args, **kwargs):
    return subprocess.run(args, check=True, capture_output=True, **kwargs).stdout


os.umask(0o077)
team = os.environ['APPLE_TEAM_ID']
root = Path(os.environ['RUNNER_TEMP']) / 'cohub-apple-signing'
root.mkdir(mode=0o700)
keychain = root / 'signing.keychain-db'
previous = run('security', 'list-keychains', '-d', 'user').decode()
(root / 'previous-keychains.json').write_text(json.dumps([line.strip().strip('"') for line in previous.splitlines() if line.strip()]))
password = secrets.token_urlsafe(32)
run('security', 'create-keychain', '-p', password, str(keychain))
run('security', 'set-keychain-settings', '-lut', '21600', str(keychain))
run('security', 'unlock-keychain', '-p', password, str(keychain))
outputs = {}
certificate_hashes = []
for name, variable in [('application', 'APPLE_CERTIFICATE'), ('installer', 'APPLE_INSTALLER_CERTIFICATE')]:
    encoded = os.environ.get(variable)
    if not encoded:
        continue
    certificate = root / (name + '.p12')
    certificate.write_bytes(base64.b64decode(encoded, validate=True))
    run('security', 'import', str(certificate), '-P', os.environ['APPLE_CERTIFICATE_PASSWORD'], '-T', '/usr/bin/codesign', '-T', '/usr/bin/productbuild', '-k', str(keychain))
    pem = run('openssl', 'pkcs12', '-in', str(certificate), '-passin', 'env:APPLE_CERTIFICATE_PASSWORD', '-clcerts', '-nokeys')
    der = run('openssl', 'x509', '-outform', 'DER', input=pem)
    certificate_hashes.append(hashlib.sha1(der).hexdigest().upper())
    if name == 'installer':
        subject = run('openssl', 'x509', '-noout', '-subject', '-nameopt', 'sep_multiline', input=pem).decode()
        outputs['installer-identity'] = next(line.strip()[3:] for line in subject.splitlines() if line.strip().startswith('CN='))
    else:
        outputs['identity'] = certificate_hashes[-1]
run('security', 'set-key-partition-list', '-S', 'apple-tool:,apple:', '-k', password, str(keychain))
run('security', 'list-keychains', '-d', 'user', '-s', str(keychain), *json.loads((root / 'previous-keychains.json').read_text()))
installed = []
for name, variable in [('profile', 'APPLE_PROFILE'), ('share-profile', 'APPLE_SHARE_PROFILE')]:
    encoded = os.environ.get(variable)
    if not encoded:
        continue
    profile = root / (name + '.mobileprovision')
    profile.write_bytes(base64.b64decode(encoded, validate=True))
    data = plistlib.loads(run('security', 'cms', '-D', '-i', str(profile)))
    assert data['TeamIdentifier'] == [team], 'Provisioning profile belongs to another team'
    assert data['ExpirationDate'] > datetime.datetime.now(datetime.timezone.utc).replace(tzinfo=None), 'Provisioning profile has expired'
    assert not data.get('ProvisionedDevices') and not data.get('ProvisionsAllDevices'), 'An App Store profile is required'
    assert not data['Entitlements'].get('get-task-allow', False), 'Development signing is not allowed'
    assert certificate_hashes[0] in [hashlib.sha1(cert).hexdigest().upper() for cert in data['DeveloperCertificates']], 'Profile does not include the application signing certificate'
    platform = data['Platform']
    bundle = 'live.cohub.ios' + ('.share' if name == 'share-profile' else '')
    entitlements = data['Entitlements']
    assert entitlements.get('application-identifier', entitlements.get('com.apple.application-identifier')) == team + '.' + bundle, 'Unexpected application identifier'
    if 'iOS' in platform:
        assert entitlements.get('com.apple.security.application-groups') == ['group.live.cohub.ios'], 'Missing iOS App Group'
    if 'OSX' in platform:
        assert 'com.apple.developer.associated-domains' in entitlements, 'Mac sign-in requires Associated Domains in the profile'
    directory = Path.home() / 'Library/MobileDevice/Provisioning Profiles'
    directory.mkdir(parents=True, exist_ok=True)
    destination = directory / (data['UUID'] + ('.provisionprofile' if 'OSX' in platform else '.mobileprovision'))
    assert not destination.exists(), 'Refusing to overwrite a provisioning profile'
    destination.write_bytes(profile.read_bytes())
    installed.append(str(destination))
    (root / 'installed-profiles.json').write_text(json.dumps(installed))
    outputs[name] = data['UUID']
    outputs[name + '-path'] = str(profile)
    print('Installed ' + data['Name'])
with open(os.environ['GITHUB_OUTPUT'], 'a') as f:
    for key, value in outputs.items():
        f.write(key + '=' + value + '\n')
