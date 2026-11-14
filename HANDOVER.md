# HouseRatingCard · 给接任 Muse 的指南

你接管的是一个正在运行的看房评分系统。代码与文档在本仓；活数据在 VPS 上原地运行，不需要搬。先读 [README.md](README.md)、[TECHNICAL.md](TECHNICAL.md)、[RULES.md](RULES.md)，再动手。

## 1. 资产清单（都在哪）

| 资产 | 位置 |
|---|---|
| 代码与文档 | 本仓（`deploy/` 是可部署件） |
| 活数据 | VPS `~/rating-card-vps/houses.json`（**唯一数据源**）、`add-requests.json`、照片 `public/photos/`（344 张） |
| 服务 | VPS 上 systemd `rating-card`，只听 127.0.0.1:3002；底座 nginx 在 :3000 用本项目片段 `rating-card.conf` 接入（底座归 Ansible，你不要动底座，只管自己那份片段） |
| 秘密 | Web 密码哈希与 `HOOK_TOKEN` 只在 VPS 的 `.env`（600）。你不需要知道密码明文；`HOOK_TOKEN` 的值你 SSH 上去读 `.env` 即可，存进你自己的 hook secrets，**不要打印到任何对话或日志** |
| 自动化 | 前任侧 2 条 cron＋1 条 hook（见 §2），切换前仍在前任那边运行 |

真实地址/账号（`<VPS_IP>`、`<SSH_USER>`、SSH 端口 22122）向所有者索取，或从 VPS 现行配置里读；你的 SSH 公钥需先由所有者（或前任）加入 VPS 的 authorized_keys。

## 2. 你要重建的（账号间无法直拷，只能照文本重建）

1. **每日 MLS 同步 cron**：按 `deploy/crons/mls-sync.md` 全文建，节奏每日约 09:13（所有者时区），投递到所有者指定的房源对话。
2. **每日扫新 cron**：按 `deploy/crons/new-listing-sweep.md` 全文建，约 10:13（排在同步之后，避免同写一文件）。
3. **加房 hook**：定义与脚本在 `deploy/hooks/`（60 秒轮询）；脚本从你的 secrets 读 `HOOK_TOKEN`；worker 指令就是定义里的 prompt，照它执行（查卡去重 → REW 核实 → 入卡/标查不到）。
4. 部署件本体（`server.js` 等）VPS 上在跑，**不要重装**；只有机器重建时才走 TECHNICAL §3 的流程。

## 3. 切换协议（所有者下令后才执行）

1. 所有者明确说开始切换（此前你只读：可以看卡、看数据，**绝不写** `houses.json`——同一份文件两个写入方必冲突）。
2. 前任停用它的 2 条 cron＋hook，回读验证，并经所有者转交一份**「已停清单」**（停了什么、何时停、当时加房队列积压几条）给你。
3. 你收到清单后再启用你这侧的 cron/hook，避免两边同跑。
4. 首日盯一遍：同步与扫新各跑一轮，看汇报是否正常、数据校验是否通过。

## 4. 红线（长期有效）

- 唯一数据源是 VPS 上的 `houses.json`：永远以它当次内容为底稿，**禁止用任何本地副本覆盖**；写前备份、写后校验 JSON、确认服务 active。
- 业务口径以 [RULES.md](RULES.md) 为准：同步不许碰评分/看过/排除原因/备注原文；年代线、2 房、多拼的硬排除不要自创例外。
- 抓取节奏：串行、停顿、遇 429 立即停该来源（RULES §9）。宁可未核实，不可触发限流。
- 照片/链接/坐标的来源纪律（RULES §7）不要降级：搜索卡的价格出过多次错，街名级坐标钉错过 2.6 公里。

## 5. 已知坑

- **VPS 出口抓 REW/Zolo/Realtor 全部 403**：一切挂牌核实必须在你（Muse）侧用浏览器做，VPS 只存数据。
- BCRES 协作链接是 Token Login 页，打不开挂牌内容，别拿它取照片或字段。
- 未登录调 `/api/houses` 的 401 是登录门正常工作，不是故障——验证服务活着用 `systemctl is-active rating-card`。
- 旧机上还有一份已停用的老部署（文件留档）：不要往那台写任何东西，以所有者给你的现行地址为准。
- Cron 与 hook 的投递对话、所有者的汇报习惯（有变化必带价格、无变化不打扰）都在各自全文里，照着执行即可。
