# CityBrain npm 发布指南

本文面向项目维护者。普通用户只需要执行：

```bash
npm install --global citybrain-agent
citybrain
```

## 首次发布

### 1. 检查 npm 包名

```bash
npm view citybrain-agent
```

如果返回 `E404`，表示该名称目前尚未被注册。未发布前包名仍可能被其他人注册，应尽快完成首次发布。

### 2. 登录 npm

先在 <https://www.npmjs.com/> 创建账号并启用双重验证，然后执行：

```bash
npm login
npm whoami
```

### 3. 本地发布前检查

```bash
npm ci
npm run check
npm run build
npm pack --dry-run
```

确认输出中至少包含：

```text
dist/main.js
dist/web/index.html
dist/web/assets/
README.md
package.json
```

### 4. 首次发布到 npm

```bash
npm publish --access public
```

npm 可能要求输入双重验证码。发布成功后验证：

```bash
npm view citybrain-agent version
npx --yes citybrain-agent@latest --version
```

## 配置 GitHub 自动发布

首次手工发布成功后，可以在 npm 包设置中添加 Trusted Publisher：

```text
提供方：GitHub Actions
组织或用户：forgiser
仓库：citybrain-agent
工作流文件：publish-npm.yml
环境：留空
允许操作：publish
```

工作流位于：

```text
.github/workflows/publish-npm.yml
```

该方式使用 GitHub OIDC 短期凭据，不需要在仓库中保存长期 `NPM_TOKEN`。

## 发布后续版本

npm 不允许覆盖已经发布的同名同版本。每次发布前必须更新版本号：

```bash
npm version patch
git push origin main --follow-tags
```

版本类型：

- `patch`：缺陷修复，例如 `0.1.0` → `0.1.1`。
- `minor`：向后兼容的新功能，例如 `0.1.0` → `0.2.0`。
- `major`：不兼容变更，例如 `0.1.0` → `1.0.0`。

推送版本后，在 GitHub 仓库中创建对应的 Release：

1. 打开仓库的 `Releases` 页面。
2. 选择 `Draft a new release`。
3. 选择由 `npm version` 创建的标签，例如 `v0.1.1`。
4. 填写版本说明并发布 Release。
5. GitHub Actions 自动执行 npm 发布工作流。

发布完成后验证：

```bash
npm view citybrain-agent version
npm install --global citybrain-agent@latest
citybrain --version
```

## 发布失败排查

### 包名无权限

如果 `citybrain-agent` 已被其他账号注册，需要改用作用域包名：

```json
{
  "name": "@你的npm用户名/citybrain"
}
```

对应安装命令变为：

```bash
npm install --global @你的npm用户名/citybrain
```

执行命令仍然是 `citybrain`。

### 版本已经存在

```bash
npm version patch
```

不要尝试覆盖已经发布的版本。

### GitHub Actions 无发布权限

检查 npm Trusted Publisher 中的 GitHub 用户、仓库名和工作流文件名是否完全一致，并确认工作流具有：

```yaml
permissions:
  contents: read
  id-token: write
```

### Web UI 安装后无法打开

先确认 npm 包中包含 Web 资源：

```bash
npm pack --dry-run
```

然后执行：

```bash
citybrain web --no-open
```

访问终端输出的本地地址和 `/api/health` 接口。
