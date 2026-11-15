# 自动保存工作台的可撤销录入批次

工厂外协台账已经没有保存按钮，每改一个单元格就立即写回。本项目在保留原有资料预览工具和本地供方模拟服务的基础上，增加**按业务批次管理的可撤销录入**：机器人一次调整一组计价项，中途可继续、可核实、可撤回已执行的部分。

## 业务边界与设计约定

- **按业务项关联，不按单元格位置关联。** 门户会在后台合并保存，行还会随排序改变位置；所有操作与回读都以业务标识 `tr[data-id]` + 列名（`id:column`）为键，排序或服务端重排后仍指向同一业务项。
- **批次开始前只记录确实读到过的值**（基线）。没有读到过的单元格没有基线，撤回时不允许猜原值。
- **运行中三类变化分开登记**：本批次写入（confirmed/unconfirmed/failed）、门户计算出的派生值 `total`（只观察、机器人从不主动写）、其他人后来做的修改（external changes）。
- **确认回包丢失的写入既不算成功也不算失败**，状态为 unconfirmed；通过重新回读核实后才转为 confirmed（实际已落地）或 failed（未落地），无法归因的值保持未确认并列入待人工。
- **撤回不是整页旧值覆盖**。逐单元格分类：
  - `restored`：本批确认写入且现值仍是机器人写的值，恢复为基线原值；
  - `conflict`：现值与本批写入值不一致（别人改过），或无基线，**停下不覆盖**，交人工决定；
  - `skipped`：未确认/失败写入，没有已确认落地的值可恢复；
  - `noop`：已恢复过或现值已是原值，重复撤回不产生第二次写入。
  - 恢复写回前还会再回读一次，防止“分类之后、写入之前”插入的人工修改。
- 机器人只通过门户**可见页面**操作（填写输入框、Tab 触发自动保存、点排序按钮），不调用 `/api/edit`、`/api/human` 源端接口；源端接口只用于演示控制。

## 运行

容器内固定 Playwright 1.56.1 与匹配的 Chromium。浏览器只访问本进程启动的回环资料源，不需要访问外部门户。

```sh
npm ci
npx playwright install chromium
npm run build
npm test
npm run demo
```

`npm run demo` 先执行原有单次预览（写入 `var/captures.json`），再运行三情形批次演示（见下），全部输出来自真实浏览器操作与批次接收器的当前状态，不回放旧日志。

## 批次入口

### 浏览器批次管理台

```sh
npm run console            # 自动启动本地门户与管理台，打印两个地址
PORT=8123 npm run console  # 指定端口
SOURCE_URL=http://127.0.0.1:xxxx npm run console  # 接入已运行的门户
```

管理台页面提供：新建批次计划并执行（遇到未确认写入即停）、批次列表与详情、恢复核实、核实并继续、撤回。原门户预览页面（`npm start` 的根页面）保持不变且继续可用，管理台内提供新标签打开入口。

### 命令行

```sh
node src/batch-cli.mjs run --plan '[{"id":"a","column":"price","value":20}]' [--source=URL]
node src/batch-cli.mjs run --batch=<批次id>              # 继续已执行部分（断点续跑）
node src/batch-cli.mjs recover --batch=<批次id> [--continue]  # 回读核实未确认写入，可选续跑剩余计划
node src/batch-cli.mjs undo --batch=<批次id>             # 逐单元格撤回，冲突停下
node src/batch-cli.mjs status --batch=<批次id>           # 查看汇总与待人工问题
node src/batch-cli.mjs sort [--source=URL]               # 通过页面按钮改变行顺序
```

批次状态持久化在 `var/batches`（可用 `BATCH_DIR` 覆盖），每个批次一个带 sha256 校验和的文件，tmp+rename 原子替换，跨进程用 mkdir 锁串行化；CLI 进程退出后仍可在新进程中恢复或撤回。退出码：存在未确认写入或撤回冲突时为 2，参数/批次错误为 1。

## 演示的三种情形（`npm run demo:batch`）

1. **自动保存确认回包丢失**：写入实际落地但回包断开，批次停在 unconfirmed；全新 CLI 进程回读核实为 confirmed 后撤回，单元格恢复基线值，派生 `total` 由门户重算。
2. **人工插入修改**：机器人写入后人工改了同一业务项；撤回时该单元格报 conflict 并保留人工值不覆盖，其余业务项正常 restored。
3. **行排序变化**：页面排序叠加服务端重排后，已确认批次仍按业务 id 恢复原值、重复撤回全部 noop；含未确认写入的批次撤回时跳过该项并列入待人工，现值保留给业务同事决定。

## 模块

- `src/batch.mjs`：批次纯领域逻辑（基线、写入状态、回读核实、撤回分类、汇总），无 I/O，可独立单测。
- `src/batch-store.mjs`：带校验和、原子写与跨进程锁的批次持久化。
- `src/robot.mjs`：Playwright 机器人，只走可见页面，按业务 id 定位。
- `src/batch-cli.mjs`：批次执行/恢复/撤回/状态/排序命令行入口。
- `src/console.mjs`、`src/console-serve.mjs`、`public/console.*`：浏览器批次管理台。
- `src/demo-batch.mjs`：三情形演示编排（独立 CLI 子进程对同一门户操作）。
- `src/source.mjs`：本地资料源与演示控制（模拟器不替接收器做核对）。
- `src/domain.mjs`、`src/preview.mjs`、`src/store.mjs`：原有预览与接收文件能力，保持不变。
- `fixtures/source.json` 与 `fixtures/controls.json`：本地供方资料及可切换情形（含 `normal-reply` 恢复正常回包）。
- `docs/source.md`：接口和来源约定。

## 短时操作演示

从空 `var` 运行 `npm run demo`：先展示原有真实读取与接收路径，再输出三种情形下每个业务单元格的写入状态、撤回结论与待人工问题；`npm test` 覆盖领域规则、持久化完整性、源端边界、真实浏览器端到端链路与管理台。固定环境中应在 90 秒内完成。
