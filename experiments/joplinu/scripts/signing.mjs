import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function readSigningSecrets(names, env = process.env) {
	if (['pull_request', 'pull_request_target'].includes(env.GITHUB_EVENT_NAME)) return null;
	const values = names.map(name => env[name] ?? '');
	if (values.every(value => !value)) return null;
	if (values.some(value => !value)) throw new Error(`Configure all required signing secrets: ${names.join(', ')}`);
	return values;
}

export function decodeKey(value) {
	const compact = value.replace(/\s/g, '');
	if (!compact || compact.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(compact)) throw new Error('Signing key must be valid base64');
	const data = Buffer.from(compact, 'base64');
	if (data.toString('base64') !== compact) throw new Error('Signing key must be canonical base64');
	return data;
}

function run(command, args, options = {}) {
	try { return execFileSync(command, args, { stdio: ['pipe', 'pipe', 'pipe'], ...options }); }
	catch { throw new Error(`${command.split('/').at(-1)} failed during signing or verification`); }
}

export async function signAndroid(input, output, env = process.env) {
	const secrets = readSigningSecrets(['ANDROID_KEYSTORE_BASE64', 'ANDROID_KEYSTORE_PASSWORD', 'ANDROID_KEY_ALIAS', 'ANDROID_KEY_PASSWORD'], env);
	if (!secrets) { await copyFile(input, output); return false; }
	const [encoded, storePassword, alias, keyPassword] = secrets;
	const sdk = env.ANDROID_HOME || env.ANDROID_SDK_ROOT;
	if (!sdk) throw new Error('ANDROID_HOME is required for APK signing');
	const tools = join(sdk, 'build-tools', '36.0.0');
	const directory = await mkdtemp(join(env.RUNNER_TEMP || tmpdir(), 'joplinu-signing-'));
	try {
		const key = join(directory, 'release.keystore');
		const storePass = join(directory, 'store-password');
		const keyPass = join(directory, 'key-password');
		await writeFile(key, decodeKey(encoded), { mode: 0o600 });
		await writeFile(storePass, storePassword, { mode: 0o600 });
		await writeFile(keyPass, keyPassword, { mode: 0o600 });
		const aligned = join(directory, 'aligned.apk');
		run(join(tools, 'zipalign'), ['-f', '-P', '16', '4', input, aligned]);
		run(join(tools, 'apksigner'), ['sign', '--ks', key, '--ks-key-alias', alias, '--ks-pass', `file:${storePass}`, '--key-pass', `file:${keyPass}`, '--v4-signing-enabled', 'false', '--out', output, aligned]);
		run(join(tools, 'apksigner'), ['verify', '--verbose', output]);
		run(join(tools, 'zipalign'), ['-c', '-P', '16', '4', output]);
		return true;
	} finally { await rm(directory, { recursive: true, force: true }); }
}

export async function signRpm(file, publicKeyFile, env = process.env) {
	const secrets = readSigningSecrets(['RPM_GPG_PRIVATE_KEY_BASE64', 'RPM_GPG_KEY_ID'], env);
	if (!secrets) return false;
	const [encoded, fingerprint] = secrets;
	if (!/^(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64})$/.test(fingerprint)) throw new Error('RPM_GPG_KEY_ID must be a full key fingerprint');
	const directory = await mkdtemp(join(env.RUNNER_TEMP || tmpdir(), 'joplinu-signing-'));
	const gnupg = join(directory, 'gnupg');
	try {
		await mkdir(gnupg, { mode: 0o700 });
		const commandEnv = { ...process.env, GNUPGHOME: gnupg };
		run('gpg', ['--batch', '--import'], { input: decodeKey(encoded), env: commandEnv });
		run('gpg', ['--batch', '--list-secret-keys', fingerprint], { env: commandEnv });
		const pass = join(directory, 'passphrase');
		await writeFile(pass, env.RPM_GPG_PASSPHRASE || '', { mode: 0o600 });
		run('rpmsign', [
			'--define', `_gpg_name ${fingerprint}`,
			'--define', `_gpg_path ${gnupg}`,
			'--define', '_gpg_digest_algo sha256',
			'--define', `__gpg_sign_cmd /usr/bin/gpg --batch --no-verbose --no-armor --pinentry-mode loopback --passphrase-file ${pass} --digest-algo SHA256 --local-user %{_gpg_name} --detach-sign --output %{__signature_filename} %{__plaintext_filename}`,
			'--addsign', file,
		], { env: commandEnv });
		const publicKey = run('gpg', ['--batch', '--armor', '--export', fingerprint], { env: commandEnv });
		await writeFile(publicKeyFile, publicKey);
		const database = join(directory, 'rpmdb');
		await mkdir(database);
		run('rpmkeys', ['--dbpath', database, '--import', publicKeyFile]);
		const verification = run('rpmkeys', ['--dbpath', database, '--checksig', file], { env: { ...process.env, LC_ALL: 'C' } }).toString();
		if (!/signatures OK/.test(verification)) throw new Error('RPM signature verification did not confirm a signature');
		return true;
	} finally {
		try { run('gpgconf', ['--homedir', gnupg, '--kill', 'gpg-agent']); } catch {}
		await rm(directory, { recursive: true, force: true });
	}
}
