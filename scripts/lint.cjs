const { loadESLint } = require('eslint')

async function main() {
  const args = process.argv.slice(2)
  const fix = args.includes('--fix')

  const ESLint = await loadESLint({ useFlatConfig: true })
  const linter = new ESLint({ fix })
  const results = await linter.lintFiles(['src/**/*.ts', 'tests/**/*.ts', '*.js', '*.mjs'])

  if (fix) {
    await ESLint.outputFixes(results)
  }

  const errCount = results.reduce((sum, r) => sum + r.errorCount, 0)
  const warnCount = results.reduce((sum, r) => sum + r.warningCount, 0)

  for (const result of results) {
    if (result.messages.length > 0) {
      const relPath = result.filePath.replace(process.cwd() + '/', '')
      for (const msg of result.messages) {
        const severity = msg.severity === 2 ? 'error' : 'warning'
        console.log(
          `${relPath}:${msg.line}:${msg.column} ${severity} ${msg.message} [${msg.ruleId ?? ''}]`,
        )
      }
    }
  }

  if (errCount > 0 || warnCount > 0) {
    console.log(`\n${errCount} error(s), ${warnCount} warning(s)`)
  }

  process.exit(errCount > 0 ? 1 : 0)
}

main().catch((err) => {
  console.error(err)
  process.exit(2)
})
