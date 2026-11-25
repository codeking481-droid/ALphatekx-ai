import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  compareBenchmarkReports,
  runFixtureBenchmarks,
  runRealBenchmarkMatrix,
  runRealBenchmarks,
} from './runner.js'

async function main(args) {
  const options = parseArguments(args)
  const report = options.mode === 'real'
    ? options.provider === 'all' || options.provider?.includes(',')
      ? await runRealBenchmarkMatrix({ providerIds: options.provider || 'all' })
      : await runRealBenchmarks({ providerId: options.provider })
    : await runFixtureBenchmarks()
  if (options.compare) {
    const previous = JSON.parse(await readFile(resolve(options.compare), 'utf8'))
    if (report.mode === 'real_matrix') {
      const previousProviders = new Map((previous.providers || []).map((item) => [item.provider, item]))
      const providerComparisons = report.providers.map((item) => {
        const baseline = previousProviders.get(item.provider)
        return {
          provider: item.provider,
          comparison: baseline ? compareBenchmarkReports(item, baseline) : null,
        }
      })
      report.comparison = {
        providers: providerComparisons,
        hasRegression: providerComparisons.some((item) => item.comparison?.hasRegression),
      }
    } else {
      report.comparison = compareBenchmarkReports(report, previous)
    }
  }
  const serialized = `${JSON.stringify(report, null, 2)}\n`
  if (options.output) {
    const outputPath = resolve(options.output)
    await mkdir(dirname(outputPath), { recursive: true })
    await writeFile(outputPath, serialized, 'utf8')
  }
  process.stdout.write(serialized)
  if (report.comparison?.hasRegression) process.exitCode = 2
}

function parseArguments(args) {
  const options = { mode: 'fixtures', output: null, compare: null, provider: null }
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (argument === '--mode') options.mode = args[++index]
    else if (argument === '--output') options.output = args[++index]
    else if (argument === '--compare') options.compare = args[++index]
    else if (argument === '--provider') options.provider = args[++index]
    else if (argument === '--help') {
      process.stdout.write('Usage: npm run benchmark [-- --provider all|openai,gemini] [--output path] [--compare path]\n')
      process.exit(0)
    } else {
      throw new Error(`Unknown benchmark argument "${argument}".`)
    }
  }
  if (!['fixtures', 'real'].includes(options.mode)) throw new Error('Benchmark mode must be fixtures or real.')
  if (options.mode !== 'real' && options.provider) throw new Error('--provider can only be used with --mode real.')
  if (options.provider === '') throw new Error('--provider requires an ID, a comma-separated list, or "all".')
  return options
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error.message}\n`)
    process.exitCode = 1
  })
}
