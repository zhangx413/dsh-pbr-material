# dsh-pbr-material

把一张物体的照片变成一整套**可平铺的 PBR 贴图**（albedo / normal / height / roughness /
AO / curvature / metallic，数据贴图 16-bit），全程本地跑在 ComfyUI 上。

它是 skill `pbr-material-from-photo` 的插件化版本：**判断力留在 skill 里，死板的管道搬进代码**。

| 留在 SKILL.md（给模型看） | 搬进代码（确定性执行） |
|---|---|
| 四种失败模式、硬上限、"永远别写 macro photograph" | 19 节点 ComfyUI 图怎么连、怎么提交、怎么轮询、PNG 落在哪 |
| 提示词那 5 段结构为什么这么排 | 提示词模板本身 |
| 第二步顺序为什么不能变 | 固定管线：色相选择性调色 → MakeSeamless → PBRSynth → 16bit 落盘 |
| "指标过了也要看图" | 平铺量测（与 PBRLabTileValidator 逐字段一致）+ 3×3 预览 |

## 装好之后让 agent 自己部署

```powershell
# ZIP：解压到任意目录；或 git clone https://github.com/zhangx413/dsh-pbr-material.git
node scripts\install-into-dsh.mjs
# 重启 DeepSeek Harness
```

然后**在对话里说一句**「看看 PBR 插件的环境」就行。agent 会自动做完这些：

```
pbr_setup_status                 查 ComfyUI / python / 模型库 / 磁盘 / 节点包，并报出每个路径是从哪发现的
pbr_setup_status(probe_speed)    真下几 MB 测速，推算 12.5 GB 要多久
pbr_setup_install                后台部署：验证环境 → 建自己的 run root → 链内置节点包
                                 → 下缺失权重（可续传、带镜像回退）→ 起真实例验证节点注册
```

前三件（**发现路径 / 节点包 / run root**）它自己解决；只有 **ComfyUI 本身**和 **12.5 GB 权重**
需要机器上有/要下载。插件从来不写进用户的 ComfyUI——它用自己独立的 run root 和端口。

装完插件后 agent 的 system prompt 里就有这段说明，所以**你不需要解释它要干什么**。

## 两种模式（选错是最常见的失败）

| | `mode="direct"`（直通） | `mode="generate"`（生成式，默认） |
|---|---|---|
| 是什么 | **照片就是 albedo**，只做平铺 + 推导 | 先用 FLUX.2 Klein 把照片重绘成平面 albedo，再推导 |
| 耗时 | **约 3 秒** | 约 30 秒（1024px / 20 步） |
| 分辨率 | 照片原生分辨率（如 747×1328）**原样保留** | 输出成 `size`×`size` 方图 |
| 细节 | 真实细节全留（缝、骨料、气孔、水渍、精确颜色） | **重新编造**：真实细节被"看起来合理"的通用细节替换 |
| 需要描述 | 不需要（`material` 会被忽略） | 必须，而且要写清颜色 + 基底 + 磨损 |
| 什么时候用 | 照片本身已经是正面平铺贴图（墙、地面、金属板、布料样片、扫描件/下载的贴图） | 照片里有物体、有透视、有背景、有光照渐变、曲面 |

这组对比是**实测**的，用一张 747×1328 的混凝土墙照片（本来就是正面平铺贴图）：

| 模式 | 产出的 albedo |
|---|---|
| `generate` | 一整片均匀灰点 —— **模板竖缝没了、大片骨料外露没了、水渍色差没了** |
| `direct` | **就是那张照片**：缝、骨料、气孔、水渍全在，747×1328 原生分辨率 |

也就是说，对一张已经拍好的贴图跑 step 1 不只是白等 26 秒，它会**把你要的东西扔掉**。
面板里这一步是显式选择，agent 侧是 `pbr_material_from_photo` 的 `mode` 参数。

## 五个工具

| 工具 | 作用 |
|---|---|
| `pbr_comfy_status` | install / python / 三个模型文件 / pbrlab 节点包 / run root / 空闲显存 / 有没有实例在跑 |
| `pbr_material_from_photo` | 全流程一条龙，`mode="direct"`/`"generate"`，返回贴图路径 + 平铺量测 |
| `pbr_check_maps` | 对任意已有贴图集做平铺量测并出 3×3 预览 |
| `pbr_setup_status` | 环境自检（路径来源 / 缺哪些权重 / 磁盘 / 测速推算耗时） |
| `pbr_setup_install` | 后台部署：验证环境 → run root → 节点包 → 下权重 → 起实例验证 |

**实例策略**：先用 `attachPorts` 找已经在跑的 ComfyUI（找的到就用你那个），找不到才自己起一个
headless 实例（端口 8288），跑完关掉。这条是刻意的——16 GB 显存装不下两份 Klein 4B + 文本编码器。
起实例前还会查一次空闲显存，低于 `minFreeVramMiB`（默认 9000 MiB）直接报错而不是 OOM。

## 前端（工作台面板）

侧边栏多一个 **PBR 材质** 图标，点开是一个整页工作台：

```
环境条   ComfyUI ✓ 模型 ✓ 已接入实例 :8288 空闲显存 13.1 GB
─────────────────────────────┬────────────────────────────────────────
① 参考图                     │ ② 怎么处理这张照片
  拖入 / 点击选择 / Ctrl+V   │   [① 照片已经是正面贴图 → 直接推导]（约 3 秒，保留原图细节）
  （缩略图预览）             │   [② 照片里有物体/透视 → 先生成再推导]（约 30 秒，细节会被重画）
                             │ ── 选"直接推导"时下面这张卡整块隐藏 ──
                             │ ③ 你的需求（中文就行）        ← 只在生成式模式下出现
                             │   [ 我想做成能平铺的旧漆，注意有种被磨过的感觉… ]
                             │   [让模型看图写英文描述]  模型：[自动：优先 … ▾]
                             │ ④ 给生图模型的材质描述（AI 写，可手改）
                             │   [ weathered orange-red enamel paint on metal… ]
                             │   预设: 橙红旧漆 风化黄漆 锈蚀钢板 清水混凝土 脏帆布 木地板
                             │ ── 下面这张卡两种模式都在 ──
                             │ ⑤ 输出文件夹 [...........] [选择…]
                             │ 资产命名：类别 [Military] 名称 [SandBag] 版本 [01]
                             │ ▸ 高级参数：尺寸/步数/CFG/种子/调色/金属度/粗糙度
                             │ [ 直接推导 PBR 贴图集（约 3 秒） ]
─────────────────────────────┴────────────────────────────────────────
进度 · ② 平铺 + 推导 PBR 3s   ‹日志滚动›
⑥ 结果 · 7 张贴图（缩略图 + 每张的 PASS/veto/FAIL）  [打开输出文件夹] [复制路径]
  3×3 平铺预览（接缝与镜像花纹只能这样看）· 法线 |n| 校验
本次会话的生成记录（可点回去看任一历史任务）
```

**② 的模式选择是这一版最重要的改动**（见上面「两种模式」）：直通模式下 ③④ 两块描述整块隐藏，
因为那一步根本不会发生——不问你英文，也不需要你写中文。

**③ 和 ④ 是两件不同的东西**：③ 收的是**你的意图**（中文、口语、随便写），
④ 才是喂给 FLUX 的那一句英文。把它们合成一栏，就等于逼你用英文写 prompt，而中文描述对
指令编辑模型基本无效——出来的就是一张通用 AI 纹理。所以：

- ② 下面那个按钮让**一个多模态模型真的去看参考图**，再结合你的意图写出 ③（颜色 + 基底 + 磨损，
  并且必须点出照片里那些中性/对比区域，因为后面调色那步要保住它们）。
- **③ 空着直接点生成也行**：它会先写描述再跑管线。③ 里已经有字就绝不覆盖，直接用它。
- 模型走 DSH 自己的 `llm` 服务（`ctx.get('llm')`），用的是你配好的 provider 和凭据——
  这个插件从头到尾不碰任何 API key。下拉里列的是**声明支持图片输入**的模型；一个都没有时
  会退化成列出全部模型并给出警告，让你手动指定。
- 写描述用的模型和 provider 会记进 job 日志和 manifest，事后能对上。

几个刻意的设计：

- **面板直连管线，不经过对话**。生成按钮直接打宿主的 REST 路由，任务在后台跑，面板轮询进度；
  对话不受阻塞，可以同时聊别的。
- **输出目录用系统目录选择器**（`ctx.uiWorkspace.pickDirectory()`）。选中的目录是**父目录**，
  每套材质在它下面自动建一个自己的文件夹。
- **`veto` 单独一档**，不是 `FAIL`：主判据通过、只有单像素否决线越线的贴图单独标出来，
  并在结果里解释（见下面「实测结果」）。
- **参考图和 3×3 预览放进 `preview/` 子目录**，不污染贴图目录；manifest 在材质文件夹根上。

## 资产命名（一套材质一个文件夹）

面板 ④ 里填 **资源类别 / 资源名称 / 版本**，下面会**实时显示宿主的文件计划**——
预览不是前端自己算的，是打 `/api/naming` 让宿主返回的，所以它和真正会写出来的东西不可能不一致。

```
<你选的输出目录>\
  T_Military_SandBag_01\
    T_Military_SandBag_01_C.png      固有色
    T_Military_SandBag_01_N.png      法线        (16-bit)
    T_Military_SandBag_01_R.png      粗糙度      (16-bit)
    T_Military_SandBag_01_AO.png     AO          (16-bit)
    T_Military_SandBag_01_M.png      金属度      (16-bit)
    T_Military_SandBag_01_H.png      高度图      (16-bit)
    T_Military_SandBag_01_CURV.png   曲率        (16-bit)
    T_Military_SandBag_01_CA.png     合图：固有色 RGB + AO Alpha        (8-bit)
    T_Military_SandBag_01_CH.png     合图：固有色 RGB + Height Alpha    (8-bit)
    T_Military_SandBag_01_NRM.png    合图：法线 RG + 粗糙度 B + 金属度 A (8-bit)
    manifest.json
    preview\
      T_Military_SandBag_01_ref.png
      T_Military_SandBag_01_C_tiled3x3.png
      T_Military_SandBag_01_N_tiled3x3.png
```

几点说明：

- **后缀来自 `config.json` 的 `naming.suffixes`**，不是我硬编码在读你的表。表里没写曲率的后缀，
  我暂定 `_CURV`；哪个不对直接改配置，不用动代码。
- **合图默认 8-bit**（规范没写位深）。单张仍是 16-bit——高度和法线要那点精度，
  而 AO / 粗糙度 / 金属度本身就是 8-bit 量级，而且引擎对 16-bit RGBA PNG 支持很差。
  `_NRM` 里法线的 X/Y 是**按存储值**（已经是 `(n+1)/2`）搬过去的，引擎正好靠它重建 Z。
- **平铺量测不再靠文件名猜**：`measure_maps.py` 现在收显式的 `--map albedo=<path>`。
  命名一改，自动发现就失效了（`T_..._C.png` 里没有任何 key 前缀），所以这一步必须是显式的。
- 命名留空就退回按任务名建文件夹，行为不变。

### 它怎么被加载的

**主通道**是官方的 `dsh.client`：插件作为 bundle 被 DSH 扫描到，`package.json` 里
`"dsh": { "client": { "platform": "web" } }` + `exports["./client"]` 指向
`client/client.js`，shell 的 module loader 自己去取并执行它，bundle 用
`window.__ModuleLoader__.load({id, factory})` 注册，`factory(require)` 里
`require('react')` 拿到的就是 shell 的 react。

**副通道**（兜底，仍在）：宿主 `ctx.webServer.register` 提供
`/pbr-material/client.js` 与 `/pbr-material/api/*`，并用 `ctx.webServer.tapIndex()`
往 index.html 里注入一个 `<script defer src="/pbr-material/client.js">`。
两条路谁先到都行——bundle 顶部的 `window.__dshPbrMaterialLoaded` 守卫让第二次执行直接返回。

留副通道是因为一开始只做了它，结果**面板根本没出现**：那时 `package.json` 里没有
`dsh.client` 字段，所以扫描跳过了插件，而注入那条路又没有送到渲染端。
现在两条都开着，并且有分阶段信标（见「安装 → 加载诊断」）能看出是哪条路生效的。

**好处**：改 `client/client.js` 只需要刷新页面，连插件重载都不用。

### API

| 路由 | 作用 |
|---|---|
| `GET  api/status` | 环境就绪检查（install / python / 模型 / run root / 显存 / 已有实例） |
| `GET  api/models` | 哪些模型声明支持图片输入 + 当前 agent 默认选择（写描述用哪几个） |
| `GET  api/naming` | 按资源类别/名称/版本算出**确切的文件计划**，面板原样展示 |
| `POST api/draft` | 把参考图 + 你的意图交给多模态模型，返回一句英文材质描述 |
| `GET  api/jobs` / `GET api/job?id=` | 任务列表 / 单任务（进度、日志、结果） |
| `POST api/generate` | 起一个后台任务，立刻返回 `{id}` |
| `POST api/upload?name=` | 原始图片字节 → 内容寻址落到暂存目录 → 返回路径 |
| `GET  api/file?p=` | 取 PNG，**只允许宿主自己用过的目录**（越界 403） |
| `POST api/check` | 量测任意已有贴图集 |
| `POST api/reveal` | 在系统文件管理器里打开输出目录 |
| `POST api/hello` / `GET api/clients` | 浏览器半边的分阶段加载信标（见下） |

## 安装与部署

### 方式 A：一条命令（ZIP 或 git clone 都适用）

```powershell
node scripts\install-into-dsh.mjs --dry-run     # 先看它要改什么
node scripts\install-into-dsh.mjs               # 真装
# 然后重启 DeepSeek Harness
```

它会做两件必不可少的事：把本目录 junction 进 `<profile>\node_modules\dsh-pbr-material`，
并把 `dsh-pbr-material` 写进 profile 的 `dsh.profile.bundles` 与 `dependencies`。
改 `package.json` 之前会先备份（`package.json.bak-<时间戳>`），跑第二遍只会说"already"。

| 参数 | 作用 |
|---|---|
| （无） | 自动找 profile（`DSH_HOME` → `DSH_PROFILE` → `~/.dsh/profiles/*` 里第一个有 package.json 的） |
| `--profile <名字>` | 指定 profile，比如 `desktop` |
| `--profile-dir <路径>` | 直接给 profile 目录 |
| `--dry-run` | 只打印计划，不写任何东西 |
| `--force` | 目标已存在**且不是**指向本目录的链接时才需要（否则它会拒绝覆盖） |

> 为什么是 Node 不是 `.ps1`：这台机器上 Group Policy 强制 RemoteSigned，**连
> `-ExecutionPolicy Bypass` 都被覆盖**，未签名的 `.ps1` 直接拒绝加载（实测）。Node 不受此约束，
> 而且 DSH 本身就是 Node 应用，Node 必然存在。原来的 `install-into-dsh.ps1` 已因此删除。

### 方式 B：手动

它是一个 **bundle**，把仓库放进 profile 并登记即可（`<repo>` = 你 clone/解压出来的目录，
`<profile>` = `~/.dsh/profiles/<名字>`，桌面版是 `desktop`）：

```
<profile>/node_modules/dsh-pbr-material   →  链接/复制到 <repo>
<profile>/package.json
  dsh.profile.bundles: [..., "dsh-pbr-material"]
  dependencies:        "dsh-pbr-material": "link:<repo 的绝对路径>"
```

Windows 上建 junction（不用管理员权限）：

```powershell
$repo = "C:\path\to\dsh-pbr-material"
$profile = "$env:USERPROFILE\.dsh\profiles\desktop"
New-Item -ItemType Junction -Path "$profile\node_modules\dsh-pbr-material" -Target $repo
# 然后把 "dsh-pbr-material" 加进 $profile\package.json 的 dsh.profile.bundles，
# 并在 dependencies 里加 "dsh-pbr-material": "link:$repo"
```

重载插件（改宿主代码必须重启 DSH）之后，工具和侧边栏面板就都在了。

> **为什么必须是 bundle**：只有 bundle 才会被 DSH 的 `dsh.client` 扫描发现；按路径
> `insert` 的条目**扫不到 client 半边**（面板不会出现）。这条是踩过的坑，见下面「加载诊断」。

> ⚠️ junction 是手工建的，`node_modules/.modules.yaml` 里没有它。**在 profile 里跑
> `pnpm install` 会把 junction 删掉**——重装后重建一次。
>
> ⚠️ **改完宿主源码要重启 DSH**（Node 的 ESM 模块缓存会一直返回旧模块，改配置或在插件管理里
> 禁/启用都没用）；**改 `client/client.js` 只要刷新页面**。

### 跑起来需要什么（装完插件之后）

| 需要 | 谁提供 |
|---|---|
| ComfyUI（含 `main.py`） | 用户装；插件**自动发现** |
| python（带 numpy + Pillow） | ComfyUI 自带的 venv，**自动发现** |
| 三个权重，共 **12.5 GB** | **agent 自动下载**（`pbr_setup_install`） |
| pbrlab 节点包 | **插件自带**，自动链进自己的 run root |
| run root / 输出目录 | 插件在自己的数据目录建，不碰用户的 ComfyUI |

**机器路径全部留空就是自动发现**，磁盘上写死过路径这件事已经修掉了。发现来源会照实报出来：

```
ComfyUI   C:\...\Comfy Desktop\comfy-procs\inst-1792040912736.json (Comfy Desktop)
python    inside the ComfyUI install
模型库    C:\...\instance-model-paths\inst-1792040912736.yaml (Comfy Desktop, is_default=true)
run root  C:\Users\<用户>\AppData\Local\dsh-pbr-material\comfy_root
```

发现顺序：环境变量（`PBR_MATERIAL_COMFY_DIR` / `PBR_MATERIAL_PYTHON` / `PBR_MATERIAL_MODELS_DIR`）
→ **Comfy Desktop 自己写的配置**（`comfy-procs/inst-*.json` 里的 `installPath` 与 `port`；
`instance-model-paths/inst-*.yaml` 里的 `base_path`）→ 常见位置兜底。找不到就报 `problems`，
**不会静默留空**。`config.json` 里的显式值永远优先。

### agent 怎么自己部署

两个工具，装完插件就可用：

| 工具 | 作用 |
|---|---|
| `pbr_setup_status` | 环境自检：每个路径**从哪发现的**、缺哪些权重（逐个报大小）、磁盘够不够、节点包链没链上、有没有实例在跑。`probe_speed=true` 会真下 4 MB 测速并**推算全部权重要多久** |
| `pbr_setup_install` | 一条命令部署：验证 ComfyUI+python → 建 run root → 链内置节点包 → 下缺失权重 → **起真实例验证节点注册**。**后台跑**，立刻返回任务号，用 `pbr_setup_status` 的 `installJob` 看进度。幂等、可续传 |

插件的 system prompt 里也写清楚了这件事，所以**新装的机器上 agent 会知道要去部署**，
并且被要求"下 12.5 GB 之前先测速、把预计耗时告诉用户、别默默开始几小时的下载"。

### 下载：三个通道，一个都不能假定

同一天实测（决定 `lib/fetch-util.js` 存在的原因）：

| 通道 | 结果 |
|---|---|
| `huggingface.co` 直连 | 超时 |
| `huggingface.co` 走本机代理 | 302 到了，**CDN 正文卡死**（17.6s 只拿到 1060 字节） |
| **`hf-mirror.com` 直连** | 308 → HF CDN → 直连可下，实测 **330 KB/s** |

所以每个文件都同时登记 **上游 URL 和镜像 URL**，下载器按顺序轮换；`.part` + `Range` 续传，
中途断了重跑从断点继续（12.5 GB @ 330KB/s ≈ 10 小时，慢但在动；VPN 调好过的是 6.4MB/s ≈ 35 分钟）。
`downloadProxy` 配了才会走代理，且代理和直连会互相当备选。

权重清单里的 URL **不是我凭记忆写的**——是从 ComfyUI 自己的蓝图
`blueprints/Image Edit (Flux.2 Klein 4B).json` 的 `properties.models` 里读出来的，然后逐个 HEAD 验证过
（302 → CDN → 200，**没有 gated，不需要 HF token**）。字节数也是实测的：

| 文件 | 字节 | 本地实测 |
|---|---|---|
| `flux-2-klein-base-4b-fp8.safetensors` | 4,089,498,488 | 完全一致 |
| `qwen_3_4b.safetensors` | 8,044,982,048 | 完全一致 |
| `flux2-vae.safetensors` | 336,213,556 | 本地是 336,211,292（**上游改过**，所以大小不符只警告、不拒绝） |

> ⚠️ 权重的许可是各自的事（FLUX 系列 / Qwen 都不是随便商用）。插件只负责下，**商用前请自己确认**。

### 加载诊断

宿主能看见自己的路由，看不见页面，所以浏览器半边会把每个阶段回报到
`/pbr-material/api/hello`，用 `GET /pbr-material/api/clients` 读：

| 现象 | 含义 |
|---|---|
| `bundleRequests: 0` | 页面根本没请求过这份 bundle（注入没送到 / 被 CSP 挡了） |
| `bundleRequests > 0`，`beacons: []` | 拿到了但没执行（MIME、CSP、脚本被拦） |
| 有 `bundle-start` 没 `loader-found` | `window.__ModuleLoader__` 一直没出现 |
| 有 `loader-found` 没 `factory` | module loader 拒绝了这次 `load()`（看 `boot-error` 的 detail） |
| 有 `applied` | 已注册，图标应该出现在侧边栏 |

这套信标是排查"面板没出现"的唯一手段——没有 devtools 时，它是唯一能区分
"没被加载" 和 "加载了但失败" 的东西。

## 配置

**全部可选项。** 机器路径留空 = 自动发现（见上），只有自动发现找错时才需要 `config.json`。
优先级：内置默认 < 自动发现 < `config.json` < profile patch 行里的 `config:`。

```jsonc
{
  "comfy": {
    "installDir": "",          // 空 = 自动发现（含 main.py 的目录）
    "python": "",              // 空 = 自动发现（ComfyUI 的 venv）
    "modelsDir": "",           // 空 = 自动发现（Comfy Desktop 的模型库）
    "runRoot": "",             // 空 = %LOCALAPPDATA%\dsh-pbr-material\comfy_root
    "downloadProxy": "",       // 空 = 只用直连；测下来代理和直连各有能用的时候
    "nodePackPath": "",        // 空 = 用插件自带的 assets/pbrlab
    "attachPorts": [8188, 8000, 8080, 8288],
    "spawnPort": 8288,         // 8164-8263 是 Windows 保留段，绑上去 WinError 10013
    "minFreeVramMiB": 9000,
    "shutdownOnFinish": true
  },
  "colorMatch": { "mode": "hue", "strength": 0.6, "hueLo": 5, "hueHi": 35 },
  "pbr": { "blend": 32, "baseRoughness": 0.55, "metallic": 0.0 },
  "outputDir": "",             // 空 = 会话工作区 / 当前工作区下的 pbr-materials
  "naming": { "prefix": "T_", "version": "01", "suffixes": { "albedo": "_C" /* … */ } }
}
```

`ensureRunRoot` 每次都会检查并**修复** run root：`custom_nodes\pbrlab` 链到插件自带的节点包，
`comfy_extras` 链到 ComfyUI 安装目录（重装会让它变成死链，`main.py` 直接
`FileNotFoundError: comfy_extras`）。修了什么会在 `pbr_setup_status` / `pbr_comfy_status` 里报出来。

## 目录

```
index.js              插件入口：注册五个工具 + 内置 skill + 系统提示 + 前端路由
lib/discover.js       自动发现 ComfyUI / 模型库 / python（读 Comfy Desktop 自己的配置）
lib/fetch-util.js     HTTPS + 代理 CONNECT 隧道 + 重定向，零依赖
lib/models.js         权重清单（URL/字节数/目标目录）+ 可续传下载器 + 测速
lib/setup.js          部署编排：验证 → run root → 节点包 → 下权重 → 验证节点注册
lib/config.js         默认值 / 自动发现 / config.json / patch 层合并
lib/prompts.js        第一步提示词的 5 段结构（每段都是实测过的）
lib/graphs.js         ComfyUI API 图（节点引用必须是字符串！）
lib/comfy.js          实例发现/启动/停止、上传、提交、轮询、收集产物、run root 修复
lib/pipeline.js       编排：编辑 → 调色 → PBR → 量测 → manifest
lib/draft.js          你的意图 + 参考图 → 英文材质描述（走 DSH 的 llm 服务）
lib/naming.js         资产命名规则：T_类别_名称_版本_后缀 + 合图名（纯函数，可单测）
lib/tools.js          五个工具的定义与渲染
lib/webui.js          前端路由、后台任务、加载信标
client/client.js      浏览器半边（主面板 + 侧边栏图标）
python/hue_colormatch.py   色相选择性调色（饱和度门控，中性像素不动）
python/measure_maps.py     平铺量测 + 法线有效性 + 3×3 预览（支持显式 --map）
python/pack_maps.py        合图 _CA / _CH / _NRM
skill/SKILL.md        原 skill（机器路径改为配置驱动）
scripts/dev-run.mjs   脱离 DSH 跑全流程（支持 --category/--asset/--version）
scripts/probe-graph.mjs   把图直接发给 ComfyUI，回显**完整**报错
scripts/serve-webui.mjs   把前端路由架在独立 HTTP 上，方便 curl 调
test/offline.test.mjs     图结构 / 提示词 / 配置合并 / 命名规则
test/client_render.mjs    浏览器半边：自带极简 react 运行时真渲染并驱动交互
test/webui_api.mjs        宿主路由，含用假 llm 跑通 /api/draft
test/naming_pipeline.py   显式量测 + 合图通道布局（拿真实贴图集跑）
test/metric_parity.py     与 pbrlab 的 seam_metrics 逐字段对拍
```

## 测试

**在一台干净 clone 下来的机器上，这些就够跑**（`node --test` 用的是 Node 自带 runner，
不需要 `npm install`——这个插件零运行时依赖）：

```powershell
cd <repo>
& node --test test\offline.test.mjs test\client_render.mjs test\webui_api.mjs test\download.mjs
& npm run check                 # 全部文件语法检查
```

不需要 GPU、不需要 ComfyUI、不需要网络。三个用例需要真实素材，**没素材会跳过并提示**，
不会假装失败：

```powershell
# 量测 + 合图通道布局、与 pbrlab 的 seam_metrics 逐字段对拍：需要 numpy/Pillow/torch
$env:PBR_TEST_MAPSET = '<一个含 albedo/normal/roughness/... 的目录>'
& python -B test\naming_pipeline.py
& python -B test\metric_parity.py

# 走 HTTP 真跑一次生成（起 headless 实例，约 30s）
$env:PBR_WEBUI_GENERATE = '1'
$env:PBR_TEST_PHOTO = '<一张参考照片>'
& node --test test\webui_api.mjs
```

| 测试 | 测什么 |
|---|---|
| `offline.test.mjs` | 图结构（含"节点引用必须是字符串"）、提示词 5 段、配置合并、**命名规则**、**自动发现**（用临时目录伪造 Comfy Desktop 的配置）、**权重清单钉死** |
| `client_render.mjs` | 自带极简 react 运行时（useState/useEffect/useRef/useMemo + 重渲染循环）+ 脚本化 fetch，真的演一遍 **上传 → 点生成 → 轮询 → 出结果**；还有命名预览、目录选择器、手写描述绕过模型 |
| `webui_api.mjs` | 把插件在 DSH 里挂的那张路由表架在真实 HTTP 上；上传/越权取文件必须 403/`/api/draft`（用假 llm）/`/api/naming` 计划一致性 |
| `download.mjs` | 进程内起一个支持 Range 的假服务器，确定性测 **续传、中途断流重试、用户取消、416 丢弃、已有文件跳过** |

两个刻意的设计：生成用例**故意写进一个含中文的目录**（早期用 PowerShell 驱动时
`D:\DSH材质` 曾被静默转成 `D:\DSH??`，所以非 ASCII 路径是断言项）；`download.mjs` 不用网络，
因为真实链路是间歇的——而续传逻辑恰恰是断网时唯一救命的代码。

## 生图模型到底看不看参考图（消融实验）

会有人问：这一步是"看着照片改"，还是"照着描述凭空画"？`scripts/reference-ablation.mjs`
用同一句**不含颜色**的描述、同一个 seed、同样 384px/16 步跑了三组，再对比一次真实产物：

| 组 | 参考图 | 描述里写了颜色 | 有色像素均值 RGB |
|---|---|---|---|
| A | 橙红油桶 | 没有 | (0.85, 0.76, 0.60) 米白 |
| B | 淡黄油桶 | 没有 | (0.77, 0.71, 0.58) 米白 |
| C | 无（纯 txt2img） | 没有 | (0.72, 0.65, 0.53) 米白 |
| 真实产物 | 橙红油桶 | 写了 "orange-red" | (0.78, 0.35, 0.21) **橙** |

两个结论要分开看：

1. **照片确实被消费了**：A/B/C 三者互不相同（平均逐像素差 0.07–0.11），而且 A 连橙红油桶
   顶部/底部那条**锈迹边缘带**都学到了。参考图管的是**结构、花纹、磨损、边缘痕迹**。
2. **颜色不能指望照片**：参考图是鲜艳橙红，描述不提颜色时出来的是米白——模型退回了自己的先验。
   颜色由**描述**决定。

所以两步式不是装饰：**第 1 步给形状、描述给颜色、第 2 步再把调色拉回照片真实的漆色**
（色相掩码均值：实测 25171 个像素均值 RGB (0.4817, 0.3183, 0.2695)，
参考图自己的有色均值是 (0.461, 0.310, 0.267)——落在参考上，不是猜的）。

实用推论：**不带颜色的材质描述是弱描述。** 这也是面板 ② 必须让模型看图写、并且
prompt 强制要求"颜色 + 基底 + 磨损"的原因。

## 实测结果（`orange.png` 230×242 → 384px，seed 7）

```
step1 编辑 21.1s · step2 PBR 3.0s · 合计 37.2s（含起实例与权重加载）
调色 hue：参考图命中漆色像素 25171（skill 里记录的同一条参考图、同一算法是 25125）
albedo  8bit  wrap=0.0       ratio=0.0     PASS     ← 无缝化后首末列精确相等
normal  16bit wrap=0.012858  ratio=1.8234  FAIL(veto only)
height  16bit wrap=0.000071  ratio=0.0056  PASS
rough   16bit wrap=0.002297  ratio=0.0491  PASS
ao/curv/metallic                全部 PASS
normal 有效性：|n| 均值 1.0000，unit_frac 1.0，min Z 0.6471 → PASS
```

**normal 那条 FAIL 是否决线打空枪，不是接缝。** 判据是
`!hard_seam && (ratio <= 1.4 || wrap <= 0.02)`：这里 `wrap = 0.0129 <= 0.02`，主判据是过的，
只有单像素极值 `wrap_max = 0.5025` 越过了 0.5 的粗暴否决线。而同一张图**内部**的最大相邻步进就有
0.42、有 10000+ 个像素超过 0.05 —— 边界上那一个像素根本不是异常值。
pbrlab 自己的注释就写着 `wrap_max` "单像素就能主导，只做粗暴否决，不能当通过标准"。

**而且这一档不稳定。** 同一份输入、同一个 seed（7）、同样 384px/20 步，重跑一次得到
`wrap_max = 0.3424`（PASS）而不是 0.5025（FAIL）——ComfyUI 的异步权重换入换出不固定归约顺序，
所以整条链不是逐位可复现的。结论：**normal 的 wrap_max 在否决线附近不能当判据用**，
工具报告和面板现在都会显式提示这一点，真正的判据是 3×3 预览。
工具报告现在会把这种情况单独标成 `FAIL(veto only)` 并说明，而不是和真接缝混为一谈。

**3×3 预览看得到的东西**：没有接缝线，但有每块重复一次的竖向镜像花纹 —— 这就是
SKILL.md §"The tiling cost is a function of feature size" 里写明的、MakeSeamless 作为
"局部镜像对称"算子的固有代价。指标全过、眼睛不过，两者都成立。要根治只能不制造这条缝
（走 `PBRLabCircularVAEPad` 的从零生成路径）。

## 踩过的坑（都写进测试了）

1. **ComfyUI 图里的节点引用必须是字符串**。`[17, 0]` 会让服务端在验证期抛
   `KeyError: 17`，而报错只说 "Exception when validating node"——真正的信息藏在
   `node_errors[*].errors[0].extra_info.traceback` 里。`test/offline.test.mjs` 现在会遍历
   全图断言引用是字符串且指向存在的节点；`scripts/probe-graph.mjs` 会把这层报错完整打出来。
2. **`PBRLabTileValidator` 的 STRING 输出取不回来**——ComfyUI 的 `/history` 只存
   SaveImage 的 `images`。所以量测必须读落盘的 PNG；`measure_maps.py` 的口径与
   `PBRLabTileValidator.seam_metrics` 逐字段一致（含 0.002 的 interior 下限和
   `wrap_ratio <= 1.4 or wrap <= 0.02` 的通过规则），`test/metric_parity.py` 拿同一批数组
   和 pbrlab 的原函数对拍。
3. **Pillow 会把 16-bit RGB PNG 悄悄降到 8-bit**（灰度 16-bit 倒是走 `I;16`）。
   法线图正好就是 16-bit RGB，所以 `measure_maps.py` 自己解析 IHDR + zlib + 反滤波，
   全精度解码；`file_bits` 和 `decoded_bits` 分开报，不让人误读。
4. **源码改了不会热生效**：见上面那条警告。
