const { Agent } = require('agent-base');
const { HttpProxyAgent } = require('http-proxy-agent');
const { HttpsProxyAgent } = require('https-proxy-agent');
// urllib 2 expects one constructor for HTTP and HTTPS. Only support explicit
// HTTP(S) proxies; PAC/FTP evaluation is unnecessary for an object transport.
module.exports = class LegacyProxyAgent extends Agent {
	constructor(proxy) {
		super();
		if (!['http:', 'https:'].includes(new URL(proxy).protocol)) throw new Error('Unsupported proxy protocol');
		this.httpProxy = new HttpProxyAgent(proxy);
		this.httpsProxy = new HttpsProxyAgent(proxy);
	}
	connect(request, options) { return (options.secureEndpoint ? this.httpsProxy : this.httpProxy).connect(request, options); }
	destroy() { this.httpProxy.destroy(); this.httpsProxy.destroy(); super.destroy(); }
};
