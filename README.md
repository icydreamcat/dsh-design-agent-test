# 测试用独立平面设计 agent

一个自带引擎的平面设计 agent。做 KV、海报、封面、信息设计，以及它们底下的栅格、字体、色彩系统。

仓库里是一个**真实渲染引擎**（不是提示词封装）加一套测量工具，agent 通过它把设计做成稿子：写 scene JSON → 渲染（约 1 秒）→ 看结果 → 改。设计规范与技能随 agent 走，`node bootstrap.mjs` 一条命令接进 dsh。

## 装进 dsh

```powershell
npm install            # 唯一依赖：@napi-rs/canvas，含平台原生二进制
node bootstrap.mjs     # 把 agent 装进 desktop profile 并写好声明
```

重启 dsh，在 New Session 里选「平面设计（测试用独立 agent）」。

```powershell
node bootstrap.mjs --check            # 只报告，退出码就是判定：0 同步 / 1 漂移 / 2 源不可用
node bootstrap.mjs --profile web      # 装到别的 profile
node bootstrap.mjs --uninstall        # 摘掉声明（文件留着）
```

> **`engineDir` 是唯一随机器变化的路径。** 仓库里的 `agent/agent.cordis.yml` 写的是占位符
> `PLACEHOLDER_ENGINE_DIR`，由 `bootstrap.mjs` 在安装时替换成本机的真实路径。同理，两个本地
> 插件行（`design-policy.mjs`、`design-tools.mjs`）在安装时被写成 `file://` URL —— 这一形态是
> 必需的：相对路径会按 composition 的 `baseUrl` 解析，而桌面宿主那里指向 profile 目录；
> 裸的 `C:/…` 路径则根本不是 ESM 能导入的 specifier。
> 克隆者不需要手改任何东西，跑 `bootstrap.mjs` 就够了。
>
> 引擎在别处时用 `$env:DSH_DESIGN_ENGINE = "路径"` 覆盖。

## 命令行

引擎自己就能用，不必经过 dsh。每个子命令向 stdout 写**一个** JSON 对象，人读的说明写 stderr。

```powershell
node bin/design.mjs render  my-scene.json --out out --name draft
node bin/design.mjs render  my-scene.json --out out --name draft --psd --supersample 2
node bin/design.mjs analyze out/draft.png
node bin/design.mjs palette presets
node bin/design.mjs palette apply out/draft.png paper-grain --set strength=0.4
node bin/design.mjs tool --list
node bin/design.mjs fonts
node bin/design.mjs ladder --base 16 --ratio 1.25 --steps 7
node bin/design.mjs ramp "#8CA33C"
```

| 命令 | 做什么 |
|---|---|
| `render <scene.json>` | 渲染场景为 PNG，写回测量报告（`--psd` 另存分层 PSD，`--scale` 出快稿，`--supersample` 抗锯齿） |
| `analyze <image>` | 把一张图测成**规格**：地面明度、强调色占比（含平涂口径）、明度直方图、栅格间距、笔画权重、细节分布 |
| `palette` | 滤镜词汇与预设库：`ops` 列算子、`presets` 列预设、`show` 打印算子图、`apply`／`run` 跑在一张图上 |
| `tool` | 23 个测量与素材工具，从各自文件头自动枚举 |
| `fonts` | 引擎真正能排的字体族，带字重轴与语种覆盖 |
| `ladder` / `ramp` | 字阶 / 由一枚基色生成 OKLab 色阶，附对比度 |

## agent 侧

```
agent/agent.cordis.yml    组合：persona、常驻纪律、引擎工具、技能目录
agent/design-policy.mjs   常驻纪律作为一条 prompt section
agent/design-tools.mjs    引擎的 CLI 子命令注册成 7 个模型可用工具
skills/                   8 份技能，按需加载
```

技能是设计知识本身：`design-foundations`、`depth-and-structure`、`colour-systems`、`typography-and-scale`、`craft-and-material`、`reference-analysis`、`filters-and-palette`、`design-judgement`。

## scene 是什么

一个声明式 JSON：画布、地面、一叠图层。**从空文件写起**，不要照抄任何现成的版面——引擎画什么由你决定。

- **长度 ≤1 是画布比例，>1 是像素。** 所以「刚刚大于 1」是**一点几像素**；要出血的形状必须用像素写。
- **线用 `x1,y1,x2,y2`**，不用 `x,y`。
- 图层支持透明度、16 种混合模式、遮罩、十种图层效果（读图层自身 alpha）、五种滤镜（半径不影响耗时）、色调算子（grain、halftone、duotone、curves…）。
- 任何效果可以带 `scope`（限定作用区域），也可以换成 `{ graph: [...] }`（palette 算子链）。
- 形状还能带**形状级 `tone`**，只在该形状自己的框内运行 —— 网点因此被限制在生成它的那个笔画里，不会溢出整个画面。

**怎么写**看技能，那里是文字形式的判断：先定唯一焦点与视线路径，再定栅格与尺度，最后才落元素。仓库里**不放示例场景**——一个现成的版面最容易被照着填，而抄走的是结果不是判断。

## 测试

```powershell
node test/run-all.mjs        # 15 个单元套件
node test/environment.mjs    # 端到端：CLI、字体、渲染→测量、工具名册、agent 组合、技能
```

产物写在仓库**旁边**的 `.cache/test/`，不落进仓库。

测试**不读任何提交在仓库里的场景**：`test/_fixture.mjs` 按需生成一个，`environment.mjs` 自己再生成一个，所以套件断言的是引擎行为，而不是某个版面的样子。

`environment.mjs` 值得单独说：它自己生成 fixture 和 scene，再用 CLI 走一遍「渲染 → 测量 → 读回数字」，然后检查两处最容易悄悄坏掉的集成面 —— agent 组合（每一行是否都能解析、本地模块是否可导入）与工具名册（每个工具是否真的能跑）。所以它在任何机器上都能给出同一个判定。

## 目录

```
bin/design.mjs      CLI 入口（唯一）
src/                引擎：渲染、合成、文字、色彩、滤镜、效果、PSD、分析
tools/              23 个测量与素材工具，各自独立可跑
agent/              dsh preset：组合、纪律、工具注册
skills/             8 份设计技能
test/               15 个单元套件 + 端到端环境检查
bootstrap.mjs       装进 dsh profile
```

仓库里**没有示例版面**。设计指引全部在 `skills/`，以文字形式给出判断；版面由 agent 自己从空白场景开始写。
