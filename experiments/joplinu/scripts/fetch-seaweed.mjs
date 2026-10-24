import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, readFile, rename, rm, chmod, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { execFileSync } from 'node:child_process';

// Test infrastructure only. This executable is never bundled into JoplinU.
const version = '4.49';
const archiveHash = '3d10545b2317adc1587be02594f97e63420fe1aa7a5ba2af9c9760804574e397';
const directory = join(process.env.RUNNER_TEMP || tmpdir(), 'joplinu-test-tools');
const target = join(directory, `weed-${version}`);
if (process.platform !== 'linux' || process.arch !== 'x64') throw new Error('Automatic test-server download supports Linux x64; provide SEAWEED_BINARY on other platforms');
await mkdir(directory, { recursive: true });
const temporary = await mkdtemp(join(directory, 'download-'));
try {
	const response = await fetch(`https://github.com/seaweedfs/seaweedfs/releases/download/${version}/linux_amd64.tar.gz`, { signal: AbortSignal.timeout(120000) });
	if (!response.ok || !response.body) throw new Error('Official test-server download failed');
	const archive = join(temporary, 'server.tar.gz'); const hash = createHash('sha256'); let downloaded = 0;
	await pipeline(Readable.fromWeb(response.body), new Transform({ transform(chunk, _encoding, callback) { downloaded += chunk.length; if (downloaded > 80 * 1024 * 1024) { callback(new Error('Test-server download exceeded its size limit')); return; } hash.update(chunk); callback(null, chunk); } }), createWriteStream(archive, { mode: 0o600 }));
	if (hash.digest('hex') !== archiveHash) throw new Error('Official test-server archive SHA-256 mismatch');
	execFileSync('tar', ['-xzf', archive, '-C', temporary, 'weed'], { stdio: 'pipe' });
	const binary = join(temporary, 'weed'); await chmod(binary, 0o755);
	const binaryHash = createHash('sha256').update(await readFile(binary)).digest('hex');
	let exists = false; try { await access(target); exists = true; } catch {}
	if (exists) {
		const existing = createHash('sha256'); for await (const chunk of createReadStream(target)) existing.update(chunk);
		if (existing.digest('hex') !== binaryHash) throw new Error('An unexpected test-tool file already exists; it was not overwritten');
	} else await rename(binary, target);
	console.log(`SeaweedFS ${version} test service verified (archive SHA-256 ${archiveHash})`);
} finally { await rm(temporary, { recursive: true, force: true }); }
