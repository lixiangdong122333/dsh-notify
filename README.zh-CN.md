# dsh-notify

给 [DeepSeek-Harness](https://github.com/deepseek-ai/deepseek-harness)（下称 DSH）用的 Windows 桌面通知插件。

把任务交给 DSH，然后去忙别的事。只有当真的需要你时才把你拉回来：任务完成了，或者助手正等着你回答，都会弹一个通知。点一下通知就回到 DSH。

> 仅支持 Windows。其他平台上插件会正常加载，但不做任何事。

## 它做什么

| 什么时候 | 通知长什么样 |
| --- | --- |
| 任务正常完成 | `DSH · 任务完成`，正文是助手的最后一段回答 |
| 任务出错，或达到 token 上限 | `DSH · 任务已结束` |
| 助手向你提问，6 秒内没人回答 | `DSH · 需要你确认`，正文是那个问题 |

点通知本身，或者点上面的 **打开 DeepSeek-Harness** 按钮，DSH 就会来到前台。窗口最小化了会还原，已经收到托盘里会重新打开。这用的是桌面端本来就注册好的 `dsh://notify` 协议。

你已经在看 DSH 的时候不会打扰：页面会从浏览器那边报告自己的标签页是不是前台可见窗口，是的话就不弹。计划审核有它自己的确认界面，默认也不通知。

以上全部都能调，入口在 **设置 → 通知**（设置面板里和「通用设置」「模型」并列的一级页面），或者 **设置 → 内置插件** 里本插件那一行。

## 安装

已发布到 npm，**插件中心**用的就是它：

```bash
dsh plugin --profile web add @cmwl1231/dsh-notify
```

桌面版把 profile 换成 `desktop`：

```bash
dsh plugin --profile desktop add @cmwl1231/dsh-notify
```

也可以直接从仓库装，不经过 npm：

```bash
dsh plugin --profile web add github:lixiangdong122333/dsh-notify
```

**装之前先退出 DSH，装完再打开。** 新加的插件只在启动时读取，运行中不会热加载。

## 配置

打开 **设置 → 通知**，或者 **设置 → 内置插件 → 本插件**，两处是同一张表单。它改的是你 profile 里 `cordis.patch.yml` 的 `dsh-notify` 那一行，每次改动立即生效，底部还有一个 **发送测试通知** 按钮，用来确认整条链路是通的。

直接手改那一行效果一样，两者写的是同一份数据。所有键都可以不写，下面是没做任何覆盖时的默认值：

```yaml
- id: dsh-notify
  config:
    onTurnEnd: true              # 任务结束时通知
    notifyEndKinds:              # 哪些结束情况值得弹通知
      - completed
      - error
      - max-tokens
    minTurnMs: 0                 # 短于这个时长的任务不通知（毫秒）
    notifyQuestions: true        # 助手提问无人回答时通知
    questionDelayMs: 6000        # 提问后等多久再弹（毫秒）
    notifyPlanReviews: false     # 计划审核也通知
    skipWhenFocused: true        # 我正在看 DSH 时不打扰
    skipWhenOthersRunning: true  # 其他会话还在跑时先不打扰
    bodySource: answer           # answer | prompt | none
    bodyLength: 150              # 正文取多少字
    sound: default               # default | silent | important
    titleCompleted: "DSH · 任务完成"
    titleEnded: "DSH · 任务已结束"
    titleQuestion: "DSH · 需要你确认"
```

`notifyEndKinds` 可选的四个值是 `completed`（正常完成）、`error`（出错）、`max-tokens`（达到 token 上限）、`aborted`（我手动停止），默认配置只开前三个。另外，`forked`（会话分叉）和 `interrupted`（会话中断）属于应用内部的交接，不是一个任务结束，所以不作为可选的结束类型。`sound: important` 意味着只有「需要你确认」那条会响。

## 实现方式

插件本身是一个 Cordis 插件：导出 `apply(ctx)`，在宿主上下文上注册监听器。

**任务结束** — DSH 会把 `turn/end` 事件写进每个会话的日志。插件跟着这条流走，在任务结束时弹通知，同时跳过子代理会话和你自己手动取消的那一次。

**提问** — `user-questions/request` 到达插件的时机比网页端应答器更早。插件先把请求扣住；如果过了 `questionDelayMs` 还是没人回答，就弹通知然后让位，由正常的应答器接管。**插件从不替你回答**，也不会干扰屏幕上那张提问卡片。

**焦点判断** — 宿主提供的一个小脚本把标签页的可见性和焦点状态报回宿主。要判断「用户现在能不能看到这个」，这是唯一可靠的信号。

**投递** — `notify.ps1` 通过 WinRT 以应用自己的开始菜单快捷方式发出通知。Windows 解析通知里显示的应用名，读的是 `AppUserModelId` 注册表项，而不是通知 XML 里写的内容，所以脚本每次发送前会先把那项写好。没有这一步，通知标题栏会退化成显示快捷方式的原始路径。

## 环境要求

* Windows 10 或 11
* Windows PowerShell 5.1（所有受支持的 Windows 都自带）
* DeepSeek-Harness，并且有应用的开始菜单快捷方式

## 开发

```bash
# 插件逻辑和设置读写，跑在假上下文上，不需要装 DSH
node test-plugin.mjs

# 设置页的槽位注册（用假的模块加载器和 React）
node test-client.mjs

# 通知载荷与编码检查（Windows，会真的发一条通知）
powershell -ExecutionPolicy Bypass -File test-toast.ps1
```

`notify.ps1` 必须保留 UTF-8 BOM。Windows PowerShell 5.1 读 `.ps1` 时，如果没有 BOM 就按系统代码页解析，而按钮文字是中文，没有 BOM 就会变成乱码。测试里有专门一项守着这个。

## 发布

推送 `v*` 标签会把那个版本暂存到 npm，普通推送只跑测试。

```bash
npm version 1.2.0 --no-git-tag-version
git commit -am "Release 1.2.0"      # 只用 -am 会漏掉新文件，有新增文件时改成 git add -A
git tag v1.2.0
git push origin main --tags
```

CI 会核对标签和 `package.json` 里的版本是否一致、这个版本是否已经发布过，然后暂存。**在维护者批准之前，这个版本装不了。** 批准方式是在 <https://www.npmjs.com/package/@cmwl1231/dsh-notify> 的 *Staged versions* 里输 2FA 码。

## 许可

MIT

---

English: [README.md](./README.md)
