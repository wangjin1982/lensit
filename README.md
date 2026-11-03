# LensIt 放大镜标注工具

ZoomIt 风格的屏幕放大镜 + 标注工具，全栈三层架构：

```
前端(Electron 渲染层)  ←→  后端(Express REST API)  ←→  数据库(SQLite)
frontend/*.html|js          server/index.js            data/lensit.db
```

- **前端**：框选页 / 放大镜·标注浮层 / 控制台（设置+历史），原生 JS + Canvas，无构建步骤
- **后端**：Express，随应用自动拉起（也可独立 `npm run server`），REST API + 快照静态服务
- **数据库**：Node 内置 `node:sqlite`（零原生编译依赖；不可用时自动降级 JSON 文件存储）

## 快速开始

```
npm install        # 已装好（express + electron 44.5.1，走 npmmirror）
run.bat            # 或 npm start
```

应用驻留托盘，自动弹出控制台窗口。

## 使用流程

1. **`Ctrl+Alt+L`**（或双击托盘图标）→ 屏幕变暗，**拖拽框选**区域（右键/Esc 取消）
2. 进入**放大镜模式**：圆形镜头跟随鼠标实时放大选区内内容（画面同步刷新，像拿着放大镜移动）
   - 滚轮 或 `+` / `-`：调倍率（1.5×–8×）
   - 选区外压暗、镜头仅在选区内出现
3. **左键单击** → 冻结画面，鼠标变**标记笔**：
   - 拖拽涂写；`R/G/B/Y` 红绿蓝黄；`1/2/3` 三档笔宽；`E` 橡皮；`Ctrl+Z` 撤销；`C` 清空
   - `S` **保存到历史**（笔迹 + 区域快照存入数据库）
   - **右键** → 取消标记，回到放大镜（继续实时）
4. 放大镜模式下 **右键 / Esc** → 退出本次会话

控制台（`Ctrl+Alt+H` 或托盘菜单）：设置热键/镜头半径/默认倍率/画笔（存库、热键即时生效）、浏览与删除标注历史（缩略图来自后端快照服务）。

## 后端 API（127.0.0.1:3777）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | /api/health | 健康检查（含存储后端标识） |
| GET/PUT | /api/settings | 读/合并写设置 |
| GET/POST | /api/sessions | 列表 / 新建标注会话（可带 PNG 快照） |
| GET/DELETE | /api/sessions/:id | 详情 / 删除（联动删快照文件） |
| GET | /snapshots/*.png | 快照静态文件 |

## 开发与测试

```
npm start          # 完整应用（自动拉起后端）
npm run server     # 单独跑后端
npm run selftest   # 端到端自动化验收：固定区域→镜头→滚轮缩放→单击冻结→画笔→
                   # 保存落库→右键回镜头；截图与日志在 selftest-out/，退出码 0=PASS
npm run icon       # 重新生成托盘图标 assets/icon.png（纯 Node PNG 编码）
node tools/analyze-shot.js --file <png>   # 截图像素断言工具（自测配套）
```

已验证：后端 CRUD curl 冒烟、`npm run selftest` 全流程 PASS（strokes 落库、快照文件存在、像素级断言：镜头环出现/消失、选区压暗、笔迹出现/清除）。

## 实现要点

- **防"镜中镜"**：放大镜浮层调用 `setContentProtection(true)`（Windows 的 SetWindowDisplayAffinity），把自己的窗口从屏幕采集流中排除——镜头里看到的是窗口背后的原始画面。
- **实时画面**：渲染层 `getUserMedia` 捕获所在显示器（desktopCapturer 源），rAF 循环绘制：全屏底图 + 选区外 evenodd 压暗 + 圆形裁剪放大镜头（高倍率用最近邻采样）。
- **坐标体系**：鼠标/选区用 CSS px，绘制用物理 px（×devicePixelRatio），视频帧按 `videoW/displayW` 换算，HiDPI 一致。
- **后端自拉起**：主进程 health 探测失败时以 `ELECTRON_RUN_AS_NODE=1` 拉起 server 子进程；`node:sqlite` 需要旧版 flag 时先带 `--experimental-sqlite` 启动、失败自动去 flag 重试，仍不可用则 JSON 降级。

## 已知限制

- 一次会话作用于单块显示器（框选所在屏）；混合 DPI 多屏跨屏场景未做。
- 实时放大依赖 DXGI/WGC 采集，远程桌面会话内可能拿不到屏幕流。
- 拖动浮层会话期间真实鼠标与程序事件并存（自测即用合成输入驱动）。
