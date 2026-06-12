# Installation

## Requirements

- **Node.js**: >= 21.0.0, or **Bun** >= 1.0
- **Chrome** running and logged into the target site (for browser commands)

## Install via npm (Recommended)

```bash
npm install -g @sovovs/bycli
```

## Install from Source

```bash
git clone git@github.com:sovovs/byCLI.git
cd bycli
npm install
npm run build
npm link      # Link binary globally
bycli list  # Now you can use it anywhere!
```

## Update

```bash
npm install -g @sovovs/bycli@latest

# If you use the packaged byCLI skills, refresh them too
npx skills add sovovs/byCLI
```

Or refresh only the skills you actually use:

```bash
npx skills add sovovs/byCLI --skill bycli-adapter-author
npx skills add sovovs/byCLI --skill bycli-autofix
npx skills add sovovs/byCLI --skill bycli-browser
npx skills add sovovs/byCLI --skill bycli-usage
```

## Verify Installation

```bash
bycli --version   # Check version
bycli list        # List all commands
bycli doctor      # Diagnose connectivity
```
