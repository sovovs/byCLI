# Troubleshooting

## Common Issues

### "Extension not connected"

- Ensure the bycli Browser Bridge extension is installed and **enabled** in `chrome://extensions`.
- Run `bycli doctor` to diagnose connectivity.

### Empty data or 'Unauthorized' error

- Your login session in Chrome might have expired. Open a normal Chrome tab, navigate to the target site, and log in or refresh the page.
- Some sites have geographic restrictions (e.g., Bilibili, Zhihu from outside China).

### Browser command opens the page but still cannot read context

- A healthy Browser Bridge connection does not guarantee that the current page target exposes the data your adapter expects.
- Some browser adapters are sensitive to the active host or page context.
- Example: `bycli 1688 item` may fail with `did not expose product context` if the target is too broad.
- Retry on a real item page, refresh the page in Chrome, and if needed narrow the target, for example:

```bash
BYCLI_CDP_TARGET=detail.1688.com bycli 1688 item 841141931191 -f json
```

### Node API errors

- Make sure you are using **Node.js >= 20**. Run `node --version` to verify.

### Daemon issues

```bash
# View extension logs
curl localhost:19825/logs

# Stop the daemon
bycli daemon stop

# Full diagnostics
bycli doctor
```

> The daemon is persistent and stays alive until explicitly stopped (`bycli daemon stop`) or the package is uninstalled.

### Desktop adapter connection issues

For Electron/CDP-based adapters (Cursor, Codex, etc.):

1. Make sure the app is launched with `--remote-debugging-port=XXXX`
2. Verify the endpoint is set: `echo $BYCLI_CDP_ENDPOINT`
3. Test the endpoint: `curl http://127.0.0.1:XXXX/json/version`

### Build errors

```bash
# Clean rebuild
rm -rf dist/
npm run build

# Type check
npx tsc --noEmit
```

## Getting Help

- [GitHub Issues](https://github.com/sovovs/byCLI/issues) — Bug reports and feature requests
- Run `bycli doctor` for comprehensive diagnostics
