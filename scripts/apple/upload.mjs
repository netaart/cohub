import { createHash, sign } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const required = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
};

const file = process.argv[2];
if (!file) throw new Error('Usage: upload.mjs IPA_OR_PKG');
const platform = { '.ipa': 'IOS', '.pkg': 'MAC_OS' }[extname(file)];
if (!platform) throw new Error('Expected an IPA or PKG');
const version = required('VERSION');
const build = required('APPLE_BUILD_NUMBER');
const keyId = required('APP_STORE_CONNECT_KEY_ID');
const key = required('APP_STORE_CONNECT_KEY_P8');
const issuer = process.env.APP_STORE_CONNECT_ISSUER_ID;
const bytes = await readFile(file);
const checksum = createHash('MD5').update(bytes).digest('hex');

function token() {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const claims = { aud: 'appstoreconnect-v1', iat: now, exp: now + 300, ...(issuer ? { iss: issuer } : { sub: 'user' }) };
  const body = `${encode({ alg: 'ES256', kid: keyId, typ: 'JWT' })}.${encode(claims)}`;
  return `${body}.${sign('sha256', Buffer.from(body), { key, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`;
}

async function api(path, method = 'GET', data) {
  const response = await fetch(`https://api.appstoreconnect.apple.com/v1${path}`, {
    method,
    headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json' },
    body: data === undefined ? undefined : JSON.stringify({ data }),
    signal: AbortSignal.timeout(60_000),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(`App Store Connect HTTP ${response.status}: ${JSON.stringify(result.errors)}`);
  return result.data;
}

const apps = await api(`/apps?${new URLSearchParams({ 'filter[bundleId]': 'live.cohub.ios' })}`);
if (apps.length !== 1) throw new Error('Expected one App Store Connect app for live.cohub.ios');
const query = new URLSearchParams({ 'filter[platform]': platform, 'filter[cfBundleShortVersionString]': version, 'filter[cfBundleVersion]': build });
const uploads = await api(`/apps/${apps[0].id}/buildUploads?${query}`);
if (uploads.length > 1) throw new Error('Multiple upload reservations match this build');
let upload = uploads[0] ?? await api('/buildUploads', 'POST', {
  type: 'buildUploads',
  attributes: { platform, cfBundleShortVersionString: version, cfBundleVersion: build },
  relationships: { app: { data: { type: 'apps', id: apps[0].id } } },
});
console.log(`${platform} ${version} (${build}): upload ${upload.id}`);

if (upload.attributes.state.state === 'AWAITING_UPLOAD') {
  const files = await api(`/buildUploads/${upload.id}/buildUploadFiles`);
  const asset = files.find((item) => item.attributes.assetType === 'ASSET') ?? await api('/buildUploadFiles', 'POST', {
    type: 'buildUploadFiles',
    attributes: { assetType: 'ASSET', fileName: basename(file), fileSize: bytes.length, uti: platform === 'IOS' ? 'com.apple.ipa' : 'com.apple.pkg' },
    relationships: { buildUpload: { data: { type: 'buildUploads', id: upload.id } } },
  });
  const attributes = asset.attributes;
  if (attributes.fileName !== basename(file) || attributes.fileSize !== bytes.length) throw new Error('Existing upload file does not match this artifact');
  const previous = attributes.sourceFileChecksums?.file;
  if (previous && (previous.algorithm !== 'MD5' || previous.hash !== checksum)) throw new Error('Existing upload checksum does not match this artifact');
  if (attributes.assetDeliveryState.state === 'AWAITING_UPLOAD') {
    for (const operation of attributes.uploadOperations) {
      const body = bytes.subarray(operation.offset, operation.offset + operation.length);
      if (body.length !== operation.length) throw new Error('Invalid upload chunk bounds');
      const response = await fetch(operation.url, {
        method: operation.method,
        headers: Object.fromEntries(operation.requestHeaders.map(({ name, value }) => [name, value])),
        body,
        signal: AbortSignal.timeout(60_000),
      });
      if (!response.ok) throw new Error(`Artifact transfer failed with HTTP ${response.status}`);
    }
    await api(`/buildUploadFiles/${asset.id}`, 'PATCH', {
      type: 'buildUploadFiles', id: asset.id,
      attributes: { uploaded: true, sourceFileChecksums: { file: { algorithm: 'MD5', hash: checksum } } },
    });
  } else if (attributes.assetDeliveryState.state === 'FAILED') {
    throw new Error(`Artifact transfer failed: ${JSON.stringify(attributes.assetDeliveryState.errors)}`);
  }
}

const deadline = Date.now() + 20 * 60_000;
let previousState;
while (Date.now() < deadline) {
  upload = await api(`/buildUploads/${upload.id}?include=build`);
  const state = upload.attributes.state;
  if (state.state !== previousState) console.log(`${platform}: ${state.state}`);
  previousState = state.state;
  if (state.state === 'FAILED') throw new Error(`Apple validation failed: ${JSON.stringify(state.errors)}`);
  if (state.state === 'COMPLETE') {
    if (state.warnings?.length) console.log(`Apple warnings: ${JSON.stringify(state.warnings)}`);
    console.log(`Accepted build: ${upload.relationships?.build?.data?.id ?? upload.id}`);
    process.exit(0);
  }
  await delay(15_000);
}
throw new Error(`Apple is still processing upload ${upload.id}; inspect it before retrying`);
