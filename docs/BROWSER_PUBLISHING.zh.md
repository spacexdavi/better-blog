# 在浏览器中直接发布文章

Mizuki 现在提供 `/admin/write/` 页面。它会使用 GitHub App 把文章 Markdown 和本地图片直接提交到仓库，再由 Vercel 的 Git 集成自动重新部署网站。

## 使用前提

1. Vercel 项目通过 GitHub 导入，并且生产分支与 `PUBLIC_GITHUB_BRANCH` 一致。
2. 使用本仓库保存文章时，将 `ENABLE_CONTENT_SYNC` 设为 `false`。否则构建前的内容同步可能覆盖 `src/content/posts`。
3. GitHub App 只安装到当前 Mizuki 仓库，并授予 Repository permissions → Contents 的 Read and write 权限。Webhook 不需要开启。

## 配置

在 GitHub 的 Developer settings → GitHub Apps 中创建 App，生成并下载 Private key，然后将 App 安装到当前博客仓库。

在 Vercel 项目的环境变量中添加：

```dotenv
PUBLIC_GITHUB_OWNER=你的GitHub用户名
PUBLIC_GITHUB_REPO=你的Mizuki仓库名
PUBLIC_GITHUB_BRANCH=main
PUBLIC_GITHUB_APP_ID=GitHub App ID
PUBLIC_GITHUB_POSTS_PATH=src/content/posts
```

保存环境变量后手动重新部署一次，让配置进入静态页面。

不要把下载的 `.pem` 私钥放进仓库、Vercel 环境变量或任何公开位置。App ID、仓库名和分支名不是秘密。

## 发布文章

1. 打开 `https://你的域名/admin/write/`。
2. 填写标题、slug、日期、标签和 Markdown 正文。
3. 可添加本地图片，点击“插入”写入正文，或点击“封面”设为文章封面。
4. 选择 GitHub App 下载的 `.pem` 私钥。
5. 点击“发布到 GitHub”。

每篇文章采用目录式结构：

```text
src/content/posts/<slug>/
├── index.md
├── <图片内容哈希>.webp
└── <图片内容哈希>.png
```

页面提示提交成功后，GitHub 已经产生一个真实 commit。Vercel 部署仍需要一段时间；部署完成后文章才会出现在公开网站中。

## 安全说明

- 管理页面本身可以公开访问，真正的发布权限来自 `.pem` 私钥。
- 私钥只保存在当前页面的内存中；页面刷新后需要重新选择。
- GitHub installation token 会暂存在 `sessionStorage`，浏览器会话结束后清除。
- 该模式适合个人博客。多人协作、审批流或高安全要求场景应使用服务端鉴权的 CMS。
- 建议 GitHub App 只授权这一个仓库，并只开放必要的 Contents 权限。
