# HouseRatingCard · 技术文档

业务规则不在本文，去 [RULES.md](RULES.md)；交接流程去 [HANDOVER.md](HANDOVER.md)。本文只讲系统本身：怎么跑、怎么部署、怎么运维。

## 1. 组件

| 组件 | 形态 | 说明 |
|---|---|---|
| Web 服务 | `server.js`，Node 纯标准库、**零 npm 依赖** | systemd 单元 `rating-card`，`HOST=127.0.0.1`、`PORT=3002` |
| 前端 | `public/`：`app.js`、`index.html`、`style.css` | 服务同进程托管；`public/photos/` 是挂牌照片（344 张、约 55 MB，只在 VPS 上） |
| 数据 | `houses.json`（唯一数据源）、`add-requests.json`（手动添加房队列） | 都在服务目录里，服务直接读写 |
| 底座 | nginx 反代（Ansible 开荒部署，不属于本项目） | 独占对外 :3000；本项目靠自带片段 `location /` → 3002 接入（片段在 `deploy/nginx-route.rating-card.conf`） |
| 自动化 | Muse 侧 2 条 cron + 1 条 hook | 全文在 `deploy/crons/`、`deploy/hooks/`，职责见 §6 |

## 2. 运行环境

- OS：Debian 12；**Node.js v20**（现行 v20.20.2，LTS 即可；服务只用标准库，不跑 `npm install`）
- 无数据库、无构建步骤：代码拷上去就能跑
- 机器规格很小（2 核 / 1 GB）也够用；内存大头不在本服务

## 3. 部署（新机从零）

前置：底座已由 Ansible 装好（骨架站点＋片段目录 `/etc/nginx/muse-routes/`＋校验重载命令 `muse-nginx-reload`）；对外端口已在云防火墙放行。

1. 装 Node.js v20（发行版或 NodeSource 均可），确认 `node --version`。
2. 建目录 `~/rating-card-vps/`，放入：`server.js`、`public/`（三件代码文件；`photos/` 目录建空、照片另行迁移）、`houses.json`、`add-requests.json`（首次可为 `[]` 与 `{"requests":[]}` 形态参考现网，或整文件从旧机拷）。
3. 写 `.env`（模板 `deploy/env.example`，权限 600）：`RATING_CARD_PASSWORD_SHA256`（`printf %s '密码' | sha256sum`）、`HOOK_TOKEN`（`openssl rand -hex 32` 生成，与 Muse 侧 hook 保存的那份同值）。
4. 装 systemd 单元：`deploy/rating-card.service` 里的 `<SSH_USER>` 换成实际用户，拷到 `/etc/systemd/system/`，`systemctl daemon-reload && systemctl enable --now rating-card`。
5. 本地自检：`curl http://127.0.0.1:3002/login` 应 200；`systemctl is-active rating-card` 为 active。
6. 投放路由片段：`install -m 644 deploy/nginx-route.rating-card.conf /etc/nginx/muse-routes/rating-card.conf`，执行 `muse-nginx-reload`（它先验配置再 reload，验不过不生效）。
7. 对外自检：`http://<VPS_IP>:3000/` 应 302 跳 `/login`，登录页 200；未登录调用 `/api/houses` 返回 401——**那是登录门在正常工作，不是故障**（后续所有验证都不许拿它当故障判据）。

## 4. 数据模型（houses.json）

顶层是数组，每套一个对象。主要字段：

| 字段 | 含义 |
|---|---|
| `id` / `sortOrder` | 递增编号（新房取最大 id+1，两者同步） |
| `address` / `city` / `postalCode` | 地址，如 `9 181 Ravine Drive`；`community` 是小区名（街道名+缩写，如 `Ravine Dr`）；`label` 是门牌标签（如 `9 号`，无单元号时为 null） |
| `price` / `sqft` / `beds` / `baths` | 挂牌价、面积（平方英尺）、卧室/卫浴数（卫数只记录、不参与任何判断，见 RULES） |
| `mls` / `listingUrl` / `photoUrl` / `photoLabel` | MLS 号、挂牌页、照片（`/photos/house-<id>.jpg`） |
| `propertyType` | `双拼` / `Townhouse` / `独栋`（以挂牌来源口径为准） |
| `builtYear` | 建筑年代（核实不到留 null，不猜） |
| `strataFee` | 月物业费（元）；无物业费为 0 |
| `parking` | `"<个数> · <明细>"`，如 `2 · Underground`；无信息为 null |
| `builder` | 开发商/建筑商名（挂牌页明写才有，否则 null） |
| `status` | 五种：`保留` / `排除` / `新增` / `新盘` / `售出/下架/过期`（语义与流转见 RULES） |
| `viewed` / `rating` | 是否看过；评分（排除固定 1 分；未评分 null） |
| `exclusionReason` | 11 个枚举之一或 null（清单见 RULES） |
| `safety` / `env` | 治安与环境评级（独立字段，算法见 RULES） |
| `lat` / `lon` | 坐标（来源纪律见 RULES；定不到留 null） |
| `note` | 备注原文（任何自动化不得删改，只能按 RULES 的格式在末尾追加） |

`add-requests.json`：手动添加房队列，条目含 id、地址查询串、status（`待核实` / `已添加` / `已有` / `查不到`）、houseId。

## 5. 接口

- Web：`GET /login`、登录后 `/` 为卡面；登录态是签名 cookie（30 天，**改密码即失效**）；业务 API 在 `/api/houses*`，未登录一律 401。
- 加房队列：网页端往 `add-requests.json` 追加请求；`GET /api/add-requests/pending` 供 Muse 侧 hook 拉取，鉴权头 `X-Hook-Token`（与 `.env` 的 `HOOK_TOKEN` 比对），无钥匙 401。
- 静态：`/photos/house-<id>.jpg`。

## 6. 自动化（Muse 侧，不在 VPS 上跑）

| 任务 | 节奏 | 干什么 | 全文 |
|---|---|---|---|
| MLS 同步 cron | 每日约 09:13（所有者时区） | 逐套核实价格/面积/房数/车位/物业费/链接与挂牌状态，按 RULES 更新并备份 | `deploy/crons/mls-sync.md` |
| 扫新 cron | 每日约 10:13 | 按固定过滤扫四市新房源，核实后入卡（一般「新增」，确立新盘的入「新盘」，命中硬规则的入「排除」） | `deploy/crons/new-listing-sweep.md` |
| 加房 hook | 60 秒轮询 | 拉 `待核实` 请求 → 在 Muse 侧查卡去重、开 REW 核实 → 入卡或标 `查不到` | `deploy/hooks/` |

注意分工：核实在 Muse 侧做，因为 **VPS 出口抓 REW/Zolo/Realtor 全部 403**；VPS 只负责存数据与跑服务。

## 7. 运维

- 看状态：`systemctl status rating-card`；日志：`journalctl -u rating-card`。
- 重启：`systemctl restart rating-card`（只影响本服务；底座与其他项目不受影响）。
- 改数据纪律（任何人、任何任务）：先 `cp houses.json houses.json.bak-<日期>-<事由>`，再改，改完 `python3 -m json.tool houses.json` 校验，最后确认服务 active。**永远以 VPS 上的现行文件为底稿，禁止用任何本地旧副本覆盖。**
- 备份：同步/扫新 cron 每次运行都会在 VPS 留 `houses.json.bak-*` 并回拷一份到执行侧留档。
- 照片：新房照片从挂牌页下载封面图，验明是真 JPEG 后存 `public/photos/house-<id>.jpg`。

## 8. 故障排查

| 症状 | 先查 |
|---|---|
| 外网打不开（502） | `rating-card` 是否 active；不 active 看 journal |
| 外网 404、本地 3002 正常 | 路由片段不在 `/etc/nginx/muse-routes/` 或底座没 reload：投放片段后跑 `muse-nginx-reload` |
| `/api/houses` 返回 401 | 正常现象（未登录），不是故障 |
| houses.json 校验失败 | 立刻停写，用最近一份 `houses.json.bak-*` 回滚，再查原因 |
| 自动化说 REW 抓不到 | 先分清是限流（429，停手等明天）还是来源封锁；在 Muse 侧浏览器核实，不要在 VPS 上抓 |
