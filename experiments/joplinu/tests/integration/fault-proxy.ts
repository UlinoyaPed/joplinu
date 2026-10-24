import { createServer, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/** Fault injection around a real storage service, without mocking SDK or object operations. */
export class FaultProxy {
	private server: Server | undefined;
	endpoint = '';
	fault: 'none' | 'lost-put-response' | 'timeout-get' | 'throttle-put' = 'none';
	puts = 0; gets = 0; committedBeforeDisconnect = 0;
	constructor(private readonly target: string) {}
	async start() {
		const upstream = new URL(this.target);
		this.server = createServer((incoming, outgoing) => {
			if (incoming.method === 'PUT') this.puts++;
			if (incoming.method === 'GET') this.gets++;
			const fault = this.fault;
			if (incoming.method === 'GET' && fault === 'timeout-get') { this.fault = 'none'; incoming.resume(); return; }
			if (incoming.method === 'PUT' && fault === 'throttle-put') { this.fault = 'none'; incoming.resume(); outgoing.writeHead(503, { 'content-type': 'application/xml' }); outgoing.end('<Error><Code>SlowDown</Code><Message>Temporary test throttling</Message></Error>'); return; }
			const lose = incoming.method === 'PUT' && fault === 'lost-put-response'; if (lose) this.fault = 'none';
			// Preserve the signed Host header while forwarding to the actual loopback service.
			const forwarded = request({ hostname: upstream.hostname, port: upstream.port, path: incoming.url, method: incoming.method, headers: incoming.headers }, response => {
				if (lose) { response.resume(); response.once('end', () => { if ((response.statusCode ?? 500) < 300) this.committedBeforeDisconnect++; outgoing.destroy(); }); return; }
				outgoing.writeHead(response.statusCode ?? 500, response.headers); response.pipe(outgoing);
			});
			forwarded.on('error', () => outgoing.destroy()); incoming.on('aborted', () => forwarded.destroy()); incoming.pipe(forwarded);
		});
		await new Promise<void>(resolve => this.server!.listen(0, '127.0.0.1', resolve));
		this.endpoint = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
	}
	async close() { if (this.server) { this.server.closeAllConnections(); await new Promise<void>(resolve => this.server!.close(() => resolve())); } }
}
