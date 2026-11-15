# 本地资料源约定

/api/edit 是门户页面自身的自动保存接口，先修改原值及派生 total 再回包，dropReply 会在落地后断开连接。/api/human 接收相同编辑模拟人工修改，增加 revision。机器人只通过页面录入；源端接口用于演示控制。

## 通用控制

`GET /api/snapshot` 查看当前原始源状态；`POST /api/action` 接收 JSON 对象 `{"action":"动作名"}`。可用动作：reset、lost-reply、normal-reply（从丢包恢复为正常回包）、delay、reorder。控制只改变模拟源，不代表接收器已经处理了变化。

## 接收器侧的批次能力

批次接收器（`src/batch.mjs`、`src/batch-cli.mjs`、`src/console.mjs`）独立于本源端：它通过浏览器可见页面录入与回读，按 `id:column` 业务标识关联单元格；`/api/edit` 与 `/api/human` 只由门户页面和演示控制使用，机器人不直接调用。确认回包丢失的写入在接收器中保持 unconfirmed，经重新回读才能核实为 confirmed 或 failed；撤回时检测到 `/api/human` 造成的外部修改会标记 conflict 并停止覆盖该单元格。

所有资料均由本项目构造，包含的机构、设备、会话和文件仅供本地使用，不访问真实账号。浏览器操作应通过正常可见界面；测试用源控制接口不是业务采集捷径。

## 来源证据

源端请求记录只用于核查服务行为，接收器自身的审计、状态和输出需由扩展功能负责。源端重启会恢复默认资料，但本地接收文件不会自动清空。
