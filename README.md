# Cloudflare SSH Terminal Mobile

这是重新生成的全新项目，目录：

```text
D:\codex\cloudflare-ssh-terminal-mobile
```

功能：

- Cloudflare Worker 网页 SSH 终端
- 手机优先的全屏连接页面
- 左上角连接选择按钮
- 多 SSH 会话保留与切换
- 支持 IPv4 / IPv6 SSH 目标
- 支持密码和私钥登录
- 支持自定义手机/电脑背景图
- 无背景图时黑底白字
- 不保存 SSH 地址、用户名或密码
- xterm 已内嵌，不依赖外部 CDN
- Cloudflare Builds 可构建，已处理 `.node` 原生模块打包问题

## 背景图

放到 `image` 目录：

```text
image/desktop.png
image/mobile.png
```

也支持 `.jpg`、`.jpeg`、`.webp`、`.gif`。

没有图片时页面自动黑底白字。

## 本地运行

```powershell
cd D:\codex\cloudflare-ssh-terminal-mobile
npm install
npm run dev
```

## Cloudflare 网页构建

Cloudflare Workers Builds 配置：

```text
Build command: npm run build
Deploy command: npx wrangler deploy
```

不需要配置访问密码，不需要配置默认服务器。

`wrangler.toml` 默认保持：

```toml
ACCESS_TOKEN = ""
ALLOWED_HOSTS = ""
DEFAULT_HOST = ""
DEFAULT_PORT = "22"
DEFAULT_USERNAME = ""
```

这样访问网页时不需要 token，SSH 目标地址由你在网页里手动填写。
