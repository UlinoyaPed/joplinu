import { useEffect, useState, useSyncExternalStore } from 'react';
import { cloudBridge, cloudValue, cloudErrorMessage, CloudError, HostStorageProvider, type CloudConfig, type CloudInfo } from '../../../packages/platform/src/cloud';
import type { ProbeResult } from '../../../packages/storage/src/diagnostics';
import type { LibraryController } from '../../../packages/library/src/controller';
import { syncSession } from '../../../packages/sync/src/engine';

const defaults: CloudConfig = { kind: 's3', endpoint: '', bucket: '', prefix: 'joplinu', region: 'us-east-1', forcePathStyle: true, useCname: false };
const names = { list: '列举对象', put: '写入', head: '对象信息', get: '读取与校验', delete: '删除测试对象' };

export function CloudSettings({ controller, onLog }: { controller: LibraryController; onLog(message: string, failed?: boolean): void }) {
	const engine = syncSession(controller); useSyncExternalStore(engine.subscribe, engine.getSnapshot);
	const [info, setInfo] = useState<CloudInfo>(); const [config, setConfig] = useState(defaults);
	const [access, setAccess] = useState(''); const [secret, setSecret] = useState(''); const [token, setToken] = useState('');
	const [persist, setPersist] = useState(false); const [busy, setBusy] = useState(false); const [message, setMessage] = useState(''); const [error, setError] = useState(''); const [probe, setProbe] = useState<ProbeResult>();
	const bridge = cloudBridge();
	useEffect(() => {
		let alive = true;
		if (!bridge) { setInfo({ supported: false, configured: false, secureStorage: false, persisted: false }); return; }
		void cloudValue(bridge.info()).then(value => { if (alive) { setInfo(value); if (value.config) setConfig(value.config); setPersist(value.secureStorage); } }).catch(problem => { if (alive) setError(cloudErrorMessage(problem)); });
		return () => { alive = false; };
	}, [bridge]);
	const update = (fields: Partial<CloudConfig>) => { setConfig(value => ({ ...value, ...fields })); setProbe(undefined); setMessage(''); };
	const configure = async (test: boolean) => {
		if (!bridge) return; setError(''); setMessage(''); setProbe(undefined); setBusy(true);
		try {
			if ((access || secret || token) && (!access.trim() || !secret)) throw new Error('请同时填写 Access Key ID 和 Secret Access Key。');
			const credentials = access.trim() && secret ? { accessKeyId: access.trim(), secretAccessKey: secret, ...(token ? { sessionToken: token } : {}) } : undefined;
			const next = await cloudValue(bridge.configure({ config, persist, ...(credentials ? { credentials } : {}) }));
			setInfo(next); if (next.config) setConfig(next.config); setAccess(''); setSecret(''); setToken('');
			if (test) { const report = await cloudValue(bridge.probe()); setProbe(report); setMessage(report.ok ? '连接与读写删除检查通过。尚未上传笔记。' : '部分权限或连接检查未通过，请查看下方结果。'); onLog(report.ok ? '云存储连接诊断通过' : '云存储连接诊断未通过', !report.ok); }
			else { setMessage(persist ? '配置和凭据已交给系统安全存储保管。' : '配置仅在当前会话使用，退出后不保留本次输入的凭据。'); onLog('云存储配置已更新'); }
		} catch (problem) { setError(problem instanceof Error && problem.message.startsWith('请同时填写') ? problem.message : cloudErrorMessage(problem)); onLog('云存储操作失败', true); }
		finally { setBusy(false); }
	};
	const migrate = async () => {
		if (!bridge) return; setBusy(true); setError(''); setMessage(''); setProbe(undefined);
		let handle: string | undefined;
		try {
			if (!access.trim() || !secret) throw new Error('迁移需要填写目标存储的完整 Access Key ID 和 Secret Access Key。');
			const current = await cloudValue(bridge.info()); if (!current.configured || !current.config) throw new Error('请先配置源存储并解锁现有同步库。');
			const credentials = { accessKeyId: access.trim(), secretAccessKey: secret, ...(token ? { sessionToken: token } : {}) };
			const target = await cloudValue(bridge.openTarget({ config, credentials, persist: false })); handle = target.handle;
			if (target.config.endpoint === current.config.endpoint && target.config.bucket === current.config.bucket && target.config.prefix === current.config.prefix) throw new Error('请选择不同的目标端点、Bucket 或路径前缀。');
			const count = await engine.migrate(new HostStorageProvider(current.config.kind, bridge, current.config), new HostStorageProvider(target.config.kind, bridge, target.config, handle), async () => {
				const next = await cloudValue(bridge.configure({ config: target.config, credentials, persist })); setInfo(next); if (next.config) setConfig(next.config);
			});
			setMessage(`完整密文仓库迁移完成，已复制并校验 ${count} 个对象。源仓库保留，当前客户端已切换${persist ? '并保存配置' : '（仅本次会话）'}。其他设备需填写相同目标配置。`); onLog('完整密文仓库迁移并切换完成');
		} catch (problem) { setError(problem instanceof CloudError ? cloudErrorMessage(problem) : problem instanceof Error ? problem.message : '迁移失败，源仓库保留'); onLog('密文仓库迁移未完成，未删除源数据', true); }
		finally { if (handle) await cloudValue(bridge.closeTarget({ handle })).catch(() => {}); setAccess(''); setSecret(''); setToken(''); setBusy(false); }
	};
	if (!info && !error) return <p>正在读取云存储配置…</p>;
	if (info && !info.supported) return <div className="status-card"><strong>请在原生客户端配置云存储</strong><p>浏览器预览不保管存储凭据。当前平台尚未提供云存储桥接。</p></div>;
	return <section className="cloud-settings">
		<p className="hint">此处配置对象存储并验证权限。连接成功不代表笔记已同步。更换已连接的存储时，请填写目标配置和完整凭据，使用“迁移并切换”复制整个密文仓库。</p>
		{info?.error && <p className="hint">{info.error}</p>}
		<form onSubmit={event => { event.preventDefault(); void configure(false); }}>
			<label className="setting-field">存储类型<select value={config.kind} disabled={busy} onChange={event => update({ kind: event.target.value as CloudConfig['kind'], region: event.target.value === 'oss' ? 'cn-hangzhou' : 'us-east-1' })}><option value="s3">S3 兼容存储</option><option value="oss">阿里云 OSS</option></select></label>
			<label className="setting-field">Endpoint<input type="text" required disabled={busy} value={config.endpoint} onChange={event => update({ endpoint: event.target.value })} placeholder={config.kind === 'oss' ? 'https://oss-cn-hangzhou.aliyuncs.com' : 'https://s3.example.com'} autoComplete="off" /></label>
			<div className="cloud-field-pair"><label className="setting-field">Region<input required={config.kind === 's3'} disabled={busy} value={config.region} onChange={event => update({ region: event.target.value })} autoComplete="off" /></label><label className="setting-field">Bucket<input required disabled={busy} value={config.bucket} onChange={event => update({ bucket: event.target.value })} autoComplete="off" /></label></div>
			<label className="setting-field">对象路径前缀<input disabled={busy} value={config.prefix} onChange={event => update({ prefix: event.target.value })} autoComplete="off" /></label>
			{config.kind === 's3' ? <label className="setting-toggle"><span>Path-style 请求<small>适用于 MinIO 等自托管端点。</small></span><input type="checkbox" checked={config.forcePathStyle} disabled={busy} onChange={event => update({ forcePathStyle: event.target.checked })} /></label> : <label className="setting-toggle"><span>OSS 自定义域名（CNAME）</span><input type="checkbox" checked={config.useCname} disabled={busy} onChange={event => update({ useCname: event.target.checked })} /></label>}
			<p className="hint">默认使用 HTTPS 并校验证书，不提供关闭 TLS 校验的选项。凭据只发送给配置的存储端点；更换端点需重新填写凭据。</p>
			<label className="setting-field">Access Key ID<input type="password" disabled={busy} value={access} onChange={event => setAccess(event.target.value)} autoComplete="off" placeholder={info?.configured ? '留空保留当前端点的凭据' : ''} /></label>
			<label className="setting-field">Secret Access Key<input type="password" disabled={busy} value={secret} onChange={event => setSecret(event.target.value)} autoComplete="new-password" /></label>
			<label className="setting-field">临时令牌（可选）<input type="password" disabled={busy} value={token} onChange={event => setToken(event.target.value)} autoComplete="off" /></label>
			<label className="setting-toggle"><span>保存在系统安全存储<small>{info?.secureStorage ? '使用操作系统保护的加密凭据，不写入笔记或配置导出。' : '安全存储不可用，本次仅可临时使用，退出后清除输入的凭据。'}</small></span><input type="checkbox" checked={persist} disabled={busy || !info?.secureStorage} onChange={event => setPersist(event.target.checked)} /></label>
			<div className="button-row"><button className="primary" type="submit" disabled={busy || engine.busy}>保存配置</button><button type="button" disabled={busy || engine.busy || !config.endpoint || !config.bucket} onClick={() => void configure(true)}>{busy ? '正在处理…' : '保存并测试连接'}</button><button type="button" disabled={busy || engine.busy || !info?.configured || !engine.unlocked || !controller.syncState} onClick={() => void migrate()}>迁移并切换</button><button type="button" className="danger" disabled={busy || engine.busy || !bridge} onClick={() => { if (!bridge) return; setBusy(true); setError(''); void cloudValue(bridge.clear()).then(value => { setInfo(value); setConfig(defaults); setAccess(''); setSecret(''); setToken(''); setProbe(undefined); setMessage('云配置已清除，远端对象保持不变。'); onLog('云存储配置已清除'); }).catch(problem => setError(cloudErrorMessage(problem))).finally(() => setBusy(false)); }}>清除云配置</button></div>
		</form>
		{error && <p role="alert">{error}</p>}{message && <p role="status">{message}</p>}
		{probe && <div className="cloud-probe"><ul>{probe.steps.map((step, index) => <li key={index}><span>{names[step.operation]}</span><strong>{step.status === 'ok' ? '通过' : step.status === 'not-tested' ? '未执行' : '失败'}</strong>{step.error && <small>{cloudErrorMessage(new CloudError({ kind: step.error }))}</small>}</li>)}</ul>{probe.cleanup === 'failed' && <p className="hint">测试对象清理失败，请保留诊断结果。残留对象：{probe.leftoverKeys.join('、')}</p>}</div>}
	</section>;
}
