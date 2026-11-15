import { startConsole } from './console.mjs';
const port = Number(process.env.PORT ?? 0);
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('PORT 必须是 0 至 65535 的整数');
const sourceUrl = process.env.SOURCE_URL || null;
const consoleServer = await startConsole({ port, sourceUrl });
console.log('批次管理台：' + consoleServer.url);
console.log('录入门户：' + consoleServer.portal);
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, async () => { await consoleServer.close(); process.exit(0); });
}
