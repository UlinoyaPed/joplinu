import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export async function appVersion() {
	const version = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version;
	for (const app of ['desktop', 'android']) {
		const other = JSON.parse(await readFile(join(root, 'apps', app, 'package.json'), 'utf8')).version;
		if (version !== other) throw new Error('Application package versions must match');
	}
	return version;
}

export async function writeManifest(directory, kind, signed) {
	const files = [];
	for (const filename of (await readdir(directory)).sort()) {
		if (!/\.(apk|rpm|asc|exe)$/.test(filename)) continue;
		const hash = createHash('sha256');
		for await (const chunk of createReadStream(join(directory, filename))) hash.update(chunk);
		files.push({ filename, sha256: hash.digest('hex') });
	}
	if (!files.length) throw new Error('No build artifacts were produced');
	await writeFile(join(directory, 'SHA256SUMS'), files.map(file => `${file.sha256}  ${file.filename}\n`).join(''));
	await writeFile(join(directory, 'build-info.json'), JSON.stringify({ app: 'JoplinU', version: await appVersion(), kind, releaseSigned: signed, commit: process.env.GITHUB_SHA || 'local', files }, null, '\t') + '\n');
}
