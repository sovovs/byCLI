# 安装

## 系统要求

- **Node.js**: >= 21.0.0，或 **Bun** >= 1.0
- **Chrome** 已运行并登录目标网站（浏览器命令需要）

## 通过 npm 安装（推荐）

```bash
npm install -g @sovovs/bycli
```

## 从源码安装

```bash
git clone git@github.com:sovovs/byCLI.git
cd bycli
npm install
npm run build
npm link
bycli list
```

## 更新

```bash
npm install -g @sovovs/bycli@latest

# 如果你在用打包发布的 byCLI skills，也一起刷新
npx skills add sovovs/byCLI
```

如果你只装了部分 skill，也可以只刷新自己在用的：

```bash
npx skills add sovovs/byCLI --skill bycli-adapter-author
npx skills add sovovs/byCLI --skill bycli-autofix
npx skills add sovovs/byCLI --skill bycli-browser
npx skills add sovovs/byCLI --skill bycli-usage
```

## 验证安装

```bash
bycli --version
bycli list
bycli doctor
```
