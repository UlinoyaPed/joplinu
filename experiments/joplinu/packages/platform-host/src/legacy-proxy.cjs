const { ProxyAgent } = require('proxy-agent');
// urllib 2 expects a constructor taking a URL; current proxy-agent takes options.
module.exports = class LegacyProxyAgent extends ProxyAgent {
	constructor(proxy) { super({ getProxyForUrl: () => proxy }); }
};
