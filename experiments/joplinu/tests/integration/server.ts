import { createServer, type AddressInfo } from 'node:net';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { S3Client, ListBucketsCommand } from '@aws-sdk/client-s3';
import type { StorageCredentials } from '../../packages/storage/src/index';

async function ports(count: number) {
	const servers = Array.from({ length: count }, () => createServer());
	try {
		await Promise.all(servers.map(server => new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); })));
		return servers.map(server => (server.address() as AddressInfo).port);
	} finally { await Promise.all(servers.map(server => new Promise<void>(resolve => server.close(() => resolve())))); }
}

export class RealS3Server {
	private process: ChildProcess | undefined;
	private directory = '';
	private args: string[] = [];
	private binary = '';
	readonly bucket = `joplinu-${crypto.randomUUID()}`;
	readonly credentials: StorageCredentials = { accessKeyId: `test-${crypto.randomUUID()}`, secretAccessKey: crypto.randomUUID() + crypto.randomUUID() };
	readonly readerCredentials: StorageCredentials = { accessKeyId: `read-${crypto.randomUUID()}`, secretAccessKey: crypto.randomUUID() + crypto.randomUUID() };
	endpoint = '';
	private adminClient: S3Client | undefined;
	get admin() { if (!this.adminClient) throw new Error('Test S3 server not started'); return this.adminClient; }
	async start() {
		const binary = process.env.SEAWEED_BINARY ?? join(process.env.RUNNER_TEMP || tmpdir(), 'joplinu-test-tools', 'weed-4.49');
		this.binary = binary;
		this.directory = await mkdtemp(join(tmpdir(), 'joplinu-real-s3-'));
		const numbers = await ports(10);
		this.endpoint = `http://127.0.0.1:${numbers[6]}`;
		const config = join(this.directory, 's3-test-credentials.json');
		await writeFile(config, JSON.stringify({ identities: [
			{ name: 'integration-admin', credentials: [{ accessKey: this.credentials.accessKeyId, secretKey: this.credentials.secretAccessKey }], actions: ['Admin', 'Read', 'Write', 'List', 'Tagging'] },
			{ name: 'integration-readonly', credentials: [{ accessKey: this.readerCredentials.accessKeyId, secretKey: this.readerCredentials.secretAccessKey }], actions: ['Read', 'List'] },
		] }), { mode: 0o600 });
		this.args = ['mini', `-dir=${this.directory}`, '-ip=127.0.0.1', '-ip.bind=127.0.0.1', '-master.telemetry=false', '-webdav=false', '-admin.ui=false', '-admin.port.legacy=0', '-s3.port.iceberg=0', '-s3.port.lance=0', '-master.volumeSizeLimitMB=64', '-volume.max=3', `-bucket=${this.bucket}`, `-s3.config=${config}`, `-filer.localSocket=${join(this.directory, 'filer.sock')}`, `-s3.localSocket=${join(this.directory, 's3.sock')}`,
			...['master.port', 'master.port.grpc', 'volume.port', 'volume.port.grpc', 'filer.port', 'filer.port.grpc', 's3.port', 's3.port.grpc', 'admin.port', 'admin.port.grpc'].map((name, index) => `-${name}=${numbers[index]}`),
		];
		this.adminClient = new S3Client({ endpoint: this.endpoint, region: 'us-east-1', forcePathStyle: true, credentials: this.credentials, maxAttempts: 1, requestChecksumCalculation: 'WHEN_REQUIRED', responseChecksumValidation: 'WHEN_REQUIRED' });
		await this.boot();
	}
	private async boot() {
		this.process = spawn(this.binary, this.args, { cwd: this.directory, stdio: 'ignore' });
		let spawnFailed = false; this.process.once('error', () => { spawnFailed = true; });
		const deadline = Date.now() + 60000;
		while (Date.now() < deadline) {
			if (spawnFailed || this.process.exitCode !== null) throw new Error('Real S3 service could not start; verify the official binary and port configuration');
			try { const result = await this.admin.send(new ListBucketsCommand({}), { abortSignal: AbortSignal.timeout(1000) }); if (result.Buckets?.some(bucket => bucket.Name === this.bucket)) return; } catch { /* bounded startup polling */ }
			await new Promise(resolve => setTimeout(resolve, 200));
		}
		throw new Error('Real S3 service did not become ready');
	}
	async restart() { await this.stopProcess(); await this.boot(); }
	private async stopProcess() {
		const child = this.process;
		if (!child || child.exitCode !== null || child.signalCode !== null) return;
		await new Promise<void>(resolve => { const timer = setTimeout(() => child.kill('SIGKILL'), 5000); child.once('exit', () => { clearTimeout(timer); resolve(); }); child.kill('SIGTERM'); });
	}
	async close() { await this.stopProcess(); this.adminClient?.destroy(); if (this.directory) await rm(this.directory, { recursive: true, force: true }); }
}
