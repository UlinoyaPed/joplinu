import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readSigningSecrets, decodeKey, signAndroid } from './signing.mjs';

const names = ['KEY', 'PASSWORD'];
test('missing keys yield unsigned builds; partial or malformed secrets fail', () => {
	assert.equal(readSigningSecrets(names, {}), null);
	assert.throws(() => readSigningSecrets(names, { KEY: 'configured' }), /Configure all/);
	assert.deepEqual(readSigningSecrets(names, { KEY: 'configured', PASSWORD: 'present' }), ['configured', 'present']);
	for (const value of ['bad', '!!!!', 'a===', 'AB==']) assert.throws(() => decodeKey(value), /base64/);
	assert.equal(decodeKey(Buffer.from('fixture').toString('base64')).toString(), 'fixture');
});

test('PR contexts never use signing secrets, including same-repository PRs', () => {
	for (const event of ['pull_request', 'pull_request_target']) assert.equal(readSigningSecrets(names, { KEY: 'configured', PASSWORD: 'present', GITHUB_EVENT_NAME: event }), null);
});

test('unsigned APK collection preserves bytes and creates no signing material', async () => {
	const directory = await mkdtemp(join(tmpdir(), 'joplinu-test-'));
	try {
		const input = join(directory, 'input.apk');
		const output = join(directory, 'output.apk');
		await writeFile(input, 'unsigned fixture bytes');
		assert.equal(await signAndroid(input, output, {}), false);
		assert.equal(await readFile(output, 'utf8'), 'unsigned fixture bytes');
		assert.deepEqual((await readdir(directory)).sort(), ['input.apk', 'output.apk']);
	} finally { await rm(directory, { recursive: true, force: true }); }
});
