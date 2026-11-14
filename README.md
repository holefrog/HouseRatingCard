# HouseRatingCard · 看房评分卡

所有者在大多伦多西侧四市（Burnaby、Coquitlam、Port Coquitlam、Port Moody）看房用的 Web 评分卡：把候选房源收进一张卡，按固定规则筛选、看房后打分，**评分即最终决策**。卡上的数据是唯一数据源（历史上曾有其他形态的副本，均已中止，不要再找）。

## 现状（2026-11-13）

- 在卡 **356 套**：保留 9、排除 305、新增 2、新盘 20、售出/下架/过期 20
- 服务跑在一台 VPS 上：Node 进程只听本机 3002，对外经底座 nginx（:3000）按本项目自带的路由片段接入
- 三条自动化在运行：每日 MLS 同步（约 09:13）、每日新房源扫描（约 10:13）、手动加房队列 hook（60 秒）
- 运营正从前任 Muse 交接给新 Muse：交接协议与清单见 [HANDOVER.md](HANDOVER.md)

## 架构一瞥

```
浏览器 ──► 底座 nginx（:3000，Ansible 开荒部署）
             └─ 本项目片段 location / ──► Node 服务（127.0.0.1:3002，systemd: rating-card）
                                              ├─ public/ 前端（app.js / index.html / style.css）
                                              ├─ public/photos/ 挂牌照片（344 张，只在 VPS 上）
                                              └─ houses.json（唯一数据源）
Muse 侧 ──► 每日同步 cron / 每日扫新 cron ──SSH──► 改 houses.json（先备份、后校验）
          └─ 加房 hook（60 秒查 /api/add-requests/pending）──► 在 Muse 侧核实 REW 后入卡
```

## 文档

- [TECHNICAL.md](TECHNICAL.md)——组件、数据模型、接口、**完整部署流程（含 Node 环境）**、运维与故障排查
- [RULES.md](RULES.md)——业务规则全集：五种状态、11 个排除原因、年代线、同步/扫新/加房的口径与纪律。**改任何数据前先读它**
- [HANDOVER.md](HANDOVER.md)——给接任 Muse 的指南：资产清单、重建步骤、切换协议、已知坑
- `deploy/`——可部署件：`server.js`、前端三件、`rating-card.service`、本项目路由片段、`.env` 模板、两条 cron 全文、加房 hook 定义与脚本

## 不在仓里的东西

- `houses.json` 活数据与照片集：只在 VPS 上（本仓是代码与文档仓；数据迁移走机器对机器，不经 git）
- 一切秘密的值：登录密码哈希与 hook token 只在 VPS 的 `.env`（600 权限）；仓里只有键名与生成方法
- 部署地址、SSH 账号等真实值：只存部署侧配置，文档中以 `<VPS_IP>`、`<SSH_USER>` 占位
