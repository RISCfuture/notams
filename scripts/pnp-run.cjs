/**
 * Runs a PnP-resolved binary without the ESM PnP loader.
 * Workaround for Node 25 EBADF bug with Yarn PnP's ESM loader.
 *
 * Usage: yarn node scripts/pnp-run.cjs <package-bin> [args...]
 * Example: yarn node scripts/pnp-run.cjs typescript/bin/tsc -p tsconfig.app.json
 */
const { execFileSync } = require('child_process')

const [, , pkg, ...args] = process.argv

if (!pkg) {
  console.error('Usage: yarn node scripts/pnp-run.cjs <package/bin/path> [args...]')
  process.exit(1)
}

const resolved = require.resolve(pkg)

try {
  execFileSync(process.execPath, ['--require', './.pnp.cjs', resolved, ...args], {
    stdio: 'inherit',
    env: { ...process.env, NODE_OPTIONS: '' },
  })
} catch (e) {
  process.exit(e.status ?? 1)
}
