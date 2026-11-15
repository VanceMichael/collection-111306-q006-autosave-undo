// 批次能力演示：对同一个本地门户，用独立 CLI 子进程执行三个批次，
// 分别覆盖 ① 自动保存回包丢失（跨进程恢复+撤回）② 人工插入修改（撤回冲突+派生 total 不补偿）
// ③ 行排序变化（按业务 id 回关联、未确认跳过、重复撤回幂等）。
// 只编排接收器行为；门户故障由既有源控制动作制造，源端不替接收器做核对。
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { startSource } from './source.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const cliPath = join(here, 'batch-cli.mjs');

function runCli(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('close', code => {
      if (!stdout && code !== 0) return reject(new Error(stderr || `CLI 退出码 ${code}`));
      resolve({ code, json: stdout ? JSON.parse(stdout) : null, stderr });
    });
  });
}

async function action(source, name) {
  const response = await fetch(`${source}/api/action`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: name })
  });
  if (response.status !== 200) throw new Error(`源控制动作 ${name} 失败`);
  return response.json();
}

async function snapshot(source) {
  return (await fetch(`${source}/api/snapshot`)).json();
}

function heading(text) {
  process.stdout.write(`\n==================== ${text} ====================\n`);
}

function print(value) {
  process.stdout.write(JSON.stringify(value, null, 2) + '\n');
}

// 从汇总中取单个业务单元格的演示结论
function cellLine(summary, key) {
  const item = summary.明细.find(entry => entry.单元格 === key);
  return {
    单元格: key, 写入状态: item.写入状态, 状态说明: item.状态说明,
    撤回结论: item.撤回结论, 撤回说明: item.撤回说明, 冲突详情: item.冲突详情
  };
}

async function main() {
  const batchDir = await mkdtemp(join(tmpdir(), 'batch-demo-'));
  const sourceServer = await startSource();
  const source = sourceServer.url;
  const env = { BATCH_DIR: batchDir };
  const args = (command, flags = []) => [command, ...flags, '--source', source];
  try {
    heading('情形一：自动保存确认回包丢失 —— 跨进程恢复后撤回');
    await action(source, 'reset');
    const planA = JSON.stringify([{ id: 'a', column: 'price', value: 20 }]);
    await action(source, 'lost-reply'); // 之后的写入落地但不回包
    const interrupted = await runCli(args('run', ['--plan', planA]), env);
    print({ 批次: interrupted.json.批次, 中断: interrupted.json.中断, 进度: interrupted.json.进度, 待人工: interrupted.json.待人工问题 });
    const batchA = interrupted.json.批次;
    // 原进程已经退出；用全新的 CLI 进程恢复，证明批次状态不依赖内存
    await action(source, 'normal-reply');
    const recovered = await runCli(args('recover', ['--batch', batchA, '--continue']), env);
    print({ 核实: recovered.json.核实, 门户现值: (await snapshot(source)).rows });
    const undoneA = await runCli(args('undo', ['--batch', batchA]), env);
    print({ 撤回: undoneA.json.撤回明细, 门户终值: (await snapshot(source)).rows });

    heading('情形二：人工插入修改 —— 撤回遇冲突停下，派生 total 不由机器人补偿');
    await action(source, 'reset');
    const planB = JSON.stringify([
      { id: 'a', column: 'price', value: 30 },
      { id: 'b', column: 'price', value: 9 }
    ]);
    const ranB = await runCli(args('run', ['--plan', planB]), env);
    const batchB = ranB.json.批次;
    // 业务同事在机器人写过之后，通过源端“人工修改”入口改了同一业务项
    const human = await fetch(`${source}/api/human`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'a', column: 'price', value: 33 })
    });
    print({ 人工插入: human.status, 插入后快照: await snapshot(source) });
    const undoneB = await runCli(args('undo', ['--batch', batchB]), env);
    print({
      撤回明细: undoneB.json.撤回明细,
      a项结论: cellLine(undoneB.json.汇总, 'a:price'),
      b项结论: cellLine(undoneB.json.汇总, 'b:price'),
      门户终值: (await snapshot(source)).rows,
      说明: 'a:price 保留人工值 33 未被覆盖；b:price 已恢复原值；total 由门户随可写列重算，机器人从未写 total'
    });

    heading('情形三：行排序变化 —— 按业务 id 关联，未确认项跳过，重复撤回幂等');
    await action(source, 'reset');
    // 批次 C1：两项全部确认成功
    const planC1 = JSON.stringify([
      { id: 'a', column: 'price', value: 40 },
      { id: 'b', column: 'quantity', value: 7 }
    ]);
    const ranC1 = await runCli(args('run', ['--plan', planC1]), env);
    const batchC1 = ranC1.json.批次;
    // 先在页面排序，再由服务端重排行，制造单元格位置变化
    await action(source, 'reorder'); // 服务端行顺序变为 b,a
    const pageOrder = await runCli(args('sort'), env); // 页面按钮再反转一次
    // 批次 C2：打开丢包后执行，写入实际落地但确认回包丢失，批次停在未确认项
    await action(source, 'lost-reply');
    const planC2 = JSON.stringify([{ id: 'b', column: 'price', value: 11 }]);
    const interruptedC2 = await runCli(args('run', ['--plan', planC2]), env);
    const batchC2 = interruptedC2.json.批次;
    await action(source, 'normal-reply');
    // 不先做恢复核实，直接撤回两个批次
    const undoneC1 = await runCli(args('undo', ['--batch', batchC1]), env);
    const againC1 = await runCli(args('undo', ['--batch', batchC1]), env);
    const undoneC2 = await runCli(args('undo', ['--batch', batchC2]), env);
    print({
      C2中断项: interruptedC2.json.中断项,
      页面行顺序变化: pageOrder.json.页面行顺序,
      C1第一次撤回: undoneC1.json.撤回明细,
      C1第二次撤回: againC1.json.撤回明细,
      C2撤回_未确认跳过: undoneC2.json.撤回明细,
      C2待人工问题: undoneC2.json.待人工问题,
      门户终值: (await snapshot(source)).rows,
      说明: '排序变化后 C1 仍按业务 id 找到两行并恢复原值，重复撤回全部 noop；C2 的未确认写入不按成功或失败处理，撤回跳过并列入待人工，b:price 的现值 11 保留给业务同事决定'
    });

    heading('演示结论汇总');
    for (const [label, result] of [['情形一', undoneA], ['情形二', undoneB], ['情形三', againC1]]) {
      print({ 情形: label, 汇总: result.json.汇总, 待人工问题: result.json.待人工问题 });
    }
    print({ 情形: '情形三（未确认批次 C2）', 汇总: undoneC2.json.汇总, 待人工问题: undoneC2.json.待人工问题 });
  } finally {
    await sourceServer.close();
    await rm(batchDir, { recursive: true, force: true });
  }
}

main().catch(error => { console.error('演示失败：', error); process.exit(1); });
