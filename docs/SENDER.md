# 发送端 po-send

零第三方依赖（纯 Python 标准库），单文件即可用。对应需求：**多设备接收 + 强提醒 + 富文本/图片**；视频与交互按钮为 Pushover 服务端能力边界，不支持（视频只能以 `--url` 链接形式下发）。

## 准备凭据

1. 到 <https://pushover.net/apps/build> 创建一个 Application，得到 **API Token**（30 位）
2. 在 <https://pushover.net> 控制台首页复制你的 **User Key**
3. 三种配置方式任选其一（优先级从高到低）：
   - 命令行 `--token` / `--user`
   - 环境变量 `PUSHOVER_TOKEN` / `PUSHOVER_USER`
   - 配置文件：`cp config.example.json ~/.config/pushover/config.json` 后填入真实值

先验证凭据（不发消息，会列出账号下所有设备名）：

```bash
po-send validate
```

## 用法示例

```bash
# 普通通知（默认 priority=0）
po-send send "备份完成，耗时 12 分钟" -t "运维"

# 强提醒：所有设备重复响铃直到任意设备确认（跨设备静默是服务器原生行为）
po-send send "prod-01 CPU 95%" -t "告警" -p 2 \
    --retry 30 --expire 3600

# 强提醒 + 确认后回调你的服务端
po-send send "需要人工介入" -p 2 \
    --callback "https://ops.example.com/pushover/ack"

# 富文本 + 图片附件（仅图片，单张 <=5MB）
po-send send "<b>prod-01</b> CPU <font color='#ff0000'>95%</font>，<a href='https://grafana.example.com'>面板</a>" \
    -t "部署告警" --html -i chart.png

# 定向推送到指定设备（设备名来自 validate 输出）
po-send send "仅桌面可见" -d "mac-desktop,win-desktop"

# 链接卡片（深链 scheme 也可以，如 myapp://incident/123）
po-send send "工单已创建" --url "myapp://incident/123" --url-title "打开工单"

# 通知类消息自动消失：30 分钟后从设备上删除
po-send send "临时提示" --ttl 1800 -p 1

# 等宽字体（如日志片段），与 --html 互斥
po-send send "panic: runtime error..." --monospace

# 发送后凭回执查询确认状态（谁确认的、何时、回调是否成功）
po-send receipt <send 返回的 receipt-id>
```

## Python 调用

```python
from pushover_sender import send_message, check_receipt

body = send_message(
    TOKEN, USER_KEY,
    "<b>prod-01</b> CPU <font color='#ff0000'>95%</font>",
    title="部署告警", priority=2, html=True,
    image="chart.png",                      # 仅图片 <=5MB
    url="https://grafana.example.com", url_title="查看面板",
    retry=30, expire=3600,                  # priority=2 必备参数
)
print(body["receipt"])                      # 交给接收端/轮询确认状态
print(check_receipt(TOKEN, body["receipt"])["acknowledged"])
```

## JS（Node 18+）等价实现

```js
// send.mjs
import { readFile } from "node:fs/promises";

const form = new FormData();
form.append("token", process.env.PUSHOVER_TOKEN);
form.append("user", process.env.PUSHOVER_USER);
form.append("title", "部署告警");
form.append("message", "<b>prod-01</b> CPU <font color='#ff0000'>95%</font>");
form.append("html", "1");
form.append("priority", "2");
form.append("retry", "30");
form.append("expire", "3600");
form.append("attachment", new Blob([await readFile("chart.png")]), "chart.png");

const res = await fetch("https://api.pushover.net/1/messages.json", {
  method: "POST", body: form,
});
console.log(await res.json()); // { status:1, receipt:"..." }
```

## curl 等价

```bash
curl -s https://api.pushover.net/1/messages.json \
  -F token="$PUSHOVER_TOKEN" -F user="$PUSHOVER_USER" \
  -F title="部署告警" \
  -F "message=<b>prod-01</b> CPU 95%" -F html=1 \
  -F priority=2 -F retry=30 -F expire=3600 \
  -F attachment=@chart.png
```

## 参数速查

| 参数 | 限制 | 说明 |
|---|---|---|
| `message` | ≤1024 字符 | 正文，必填 |
| `title` | ≤250 字符 | 缺省为应用名 |
| `priority` | -2..2 | 2=强提醒重复响铃直到确认；1=高优一次响铃；0=常规；-1=静默；-2=仅角标 |
| `retry` / `expire` | ≥30s / ≤10800s | priority=2 必备；expire 上限 3 小时 |
| `callback` | URL | 仅 priority=2：确认后服务端 POST 此地址 |
| `image` | 仅图片 ≤5MB | bmp/gif/jpeg/png/tiff；**不支持视频/任意文件** |
| `html` | 白名单标签 | 仅 `<b>` `<i>` `<u>` `<font color>` `<a>`；横幅上格式被剥离，点开才可见 |
| `monospace` | — | 与 html 互斥 |
| `device` | 逗号分隔 | 缺省广播账号下全部设备（上限 10 台） |
| `url` / `url_title` | ≤512 / ≤100 字符 | 附加链接，支持 app scheme 深链 |
| `ttl` | 秒 | 到期自动从设备删除（priority=2 忽略） |
| `sound` | 见 `--help` | pushover/siren/persistent/alien 等 23 种 |
| `timestamp` | Unix 秒 | 显示时间覆盖 |

## 行为要点

- **确认同步**：priority=2 消息任意设备确认后，服务器停止对全部设备的重试；`receipt` 子命令可查 `acknowledged_by`（哪台设备确认的）。
- **额度**：每账号每月 10,000 条（超出返回 429），按用户计不按设备计。
- **附件生命周期**：设备下载后服务端即删除。
- **AI/程序调用**：加 `--json` 得到机器可读输出；`--dry-run` 无需凭据即可校验载荷。
