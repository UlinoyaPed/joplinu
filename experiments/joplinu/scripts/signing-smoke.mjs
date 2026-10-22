import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { signAndroid, signRpm } from './signing.mjs';

const [kind, input] = process.argv.slice(2);
if (!['rpm', 'apk'].includes(kind) || !input) throw new Error('Usage: signing-smoke.mjs rpm|apk <artifact>');
const directory = await mkdtemp(join(tmpdir(), 'joplinu-sign-test-'));
const password = 'temporary-test-password';
const gnupg = join(directory, 'test-gnupg');
const commandEnv = { ...process.env, GNUPGHOME: gnupg };
try {
	if (kind === 'apk') {
		const key = join(directory, 'test.keystore');
		execFileSync('keytool', ['-genkeypair', '-noprompt', '-alias', 'joplinu-test', '-keystore', key, '-storepass', password, '-keypass', password, '-keyalg', 'RSA', '-keysize', '2048', '-validity', '1', '-dname', 'CN=JoplinU CI test'], { stdio: 'pipe' });
		const signed = await signAndroid(resolve(input), join(directory, 'test-signed.apk'), {
			GITHUB_EVENT_NAME: 'signing-self-test', ANDROID_HOME: process.env.ANDROID_HOME,
			ANDROID_KEYSTORE_BASE64: (await readFile(key)).toString('base64'),
			ANDROID_KEYSTORE_PASSWORD: password, ANDROID_KEY_ALIAS: 'joplinu-test', ANDROID_KEY_PASSWORD: password,
		});
		assert.equal(signed, true);
	} else {
		await mkdir(gnupg, { mode: 0o700 });
		const gpg = args => execFileSync('gpg', ['--batch', '--pinentry-mode', 'loopback', '--passphrase', password, ...args], { env: commandEnv, stdio: 'pipe' });
		gpg(['--quick-generate-key', 'JoplinU CI test <ci@example.invalid>', 'rsa2048', 'sign', '1d']);
		const fingerprint = gpg(['--with-colons', '--list-secret-keys']).toString().split('\n').find(line => line.startsWith('fpr:')).split(':')[9];
		const file = join(directory, 'test.rpm');
		await copyFile(resolve(input), file);
		const signed = await signRpm(file, join(directory, 'public.asc'), {
			GITHUB_EVENT_NAME: 'signing-self-test', RPM_GPG_KEY_ID: fingerprint,
			RPM_GPG_PRIVATE_KEY_BASE64: gpg(['--armor', '--export-secret-keys', fingerprint]).toString('base64'), RPM_GPG_PASSPHRASE: password,
		});
		assert.equal(signed, true);
	}
	console.log(`${kind.toUpperCase()} signing and verification passed using an ephemeral test key; test outputs are discarded`);
} finally {
	if (kind === 'rpm') { try { execFileSync('gpgconf', ['--homedir', gnupg, '--kill', 'gpg-agent'], { stdio: 'pipe' }); } catch {} }
	await rm(directory, { recursive: true, force: true });
}
