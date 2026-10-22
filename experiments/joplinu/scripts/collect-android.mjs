import { mkdir, copyFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { signAndroid, readSigningSecrets } from './signing.mjs';
import { root, appVersion, writeManifest } from './artifacts.mjs';

const directory = join(root, 'artifacts/android');
await rm(directory, { recursive: true, force: true });
await mkdir(directory, { recursive: true });
const version = await appVersion();
const apkRoot = join(root, 'apps/android/native/app/build/outputs/apk');
await copyFile(join(apkRoot, 'debug/app-debug.apk'), join(directory, `joplinu-${version}-android-debug.apk`));
const hasKey = readSigningSecrets(['ANDROID_KEYSTORE_BASE64', 'ANDROID_KEYSTORE_PASSWORD', 'ANDROID_KEY_ALIAS', 'ANDROID_KEY_PASSWORD']);
const target = join(directory, `joplinu-${version}-android-release-${hasKey ? 'signed' : 'unsigned'}.apk`);
const signed = await signAndroid(join(apkRoot, 'release/app-release-unsigned.apk'), target);
await writeManifest(directory, 'android', signed);
console.log(`APK artifacts ready (${signed ? 'release signed' : 'debug installable; release unsigned'})`);
