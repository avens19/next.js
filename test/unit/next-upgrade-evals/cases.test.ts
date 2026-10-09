import { execFileSync } from 'child_process'
import { join } from 'path'

describe('batch cache and cancellation boundaries', () => {
  it('stops a cancelled verifier VM and prevents further app verification', () => {
    const program = `
      require('tsx/cjs')
      const assert = require('node:assert/strict')
      const { SandboxManager } = require('@vercel/agent-eval')
      const { verifyTree } = require('./evals/next-upgrade/verifier/verify.ts')
      let created = 0, stopped = 0, rejectCommand
      const mode = process.argv[1]
      process.env.NEXT_UPGRADE_EVAL_VERIFIER_SNAPSHOT_ID = 'controlled'
      SandboxManager.create = async () => {
        created++
        if (mode === 'creation') { process.emit('SIGTERM') }
        return { uploadFiles: async () => { if (mode === 'cleanup') { throw new Error('Controlled upload failure') } }, writeFiles: async () => {}, setWorkingDirectory: () => {},
          runCommand: async () => new Promise((_, reject) => { rejectCommand = reject; process.emit('SIGTERM') }),
          stop: async () => {
            stopped++
            if (mode === 'cleanup') { await new Promise(resolve => setImmediate(() => { process.emit('SIGTERM'); resolve() })) }
            if (mode === 'grading') { rejectCommand(new Error('Controlled verifier stopped')) }
          } }
      }
      ;(async () => {
        const error = mode === 'creation' ? /cancelled/ : mode === 'cleanup' ? /upload failure/ : /verifier stopped/
        await assert.rejects(() => verifyTree({ files: {} }, 'security-same-major', '/tmp/unused'), error)
        await assert.rejects(() => verifyTree({ files: {} }, 'security-same-major', '/tmp/unused'), /cancelled/)
        assert.equal(created, 1)
        assert.equal(stopped, 1)
      })().catch(error => { console.error(error); process.exitCode = 1 })
    `
    for (const mode of ['creation', 'grading', 'cleanup']) {
      expect(
        execFileSync(process.execPath, ['-e', program, mode], {
          cwd: join(__dirname, '../../..'),
          encoding: 'utf8',
          timeout: 10000,
        })
      ).toHaveLength(0)
    }
  })

  it('forwards process cancellation into native abort even with earlyExit disabled', () => {
    const program = `
      const assert = require('node:assert/strict')
      const fs = require('node:fs')
      const os = require('node:os')
      const path = require('node:path')
      const { pathToFileURL } = require('node:url')
      const packageRoot = path.dirname(require.resolve('@vercel/agent-eval/package.json'))
      const { registerAgent } = require('@vercel/agent-eval')
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'native-cancel-'))
      process.env.AGENT_EVAL_HANDLE_SIGNALS = '1'
      let aborted = false
      const before = process.listenerCount('SIGTERM')
      registerAgent({ name: 'controlled-cancel', displayName: 'Controlled cancellation', definition: { name: 'controlled-cancel', defaultModel: 'unused', o11yAgentName: 'codex' }, run: async (_, options) => {
        return await new Promise(resolve => {
          options.signal.addEventListener('abort', () => {
            aborted = true
            resolve({ success: false, error: 'Aborted', output: '', duration: 1 })
          }, { once: true })
          // Windows kills on SIGTERM instead of delivering it to Node listeners.
          // Exercise the registered cancellation handler on every platform.
          process.emit('SIGTERM')
        })
      } })
      ;(async () => {
        const { runExperiment } = await import(pathToFileURL(path.join(packageRoot, 'dist/lib/runner.js')))
        await runExperiment({ experimentName: 'cancel', resultsDir: directory, apiKey: '',
          fixtures: [{ name: 'cancel', path: directory, prompt: 'controlled' }],
          config: { agent: 'controlled-cancel', runs: 1, earlyExit: false, timeout: 3, sandbox: 'vercel', validation: 'none', agentOptions: { disableFastRetry: true } } })
        assert.equal(aborted, true)
        assert.equal(process.listenerCount('SIGTERM'), before)
      })().catch(error => { console.error(error); process.exitCode = 1 })
        .finally(() => fs.rmSync(directory, { recursive: true, force: true }))
    `
    expect(
      execFileSync(process.execPath, ['-e', program], {
        cwd: join(__dirname, '../../..'),
        encoding: 'utf8',
        timeout: 10000,
      })
    ).toHaveLength(0)
  })

  it('reuses live snapshots, replaces expired/deleted IDs and preserves service errors', () => {
    const program = `
      const assert = require('node:assert/strict')
      const { Snapshot, APIError } = require('@vercel/sandbox')
      const { reusableSnapshot } = require('./evals/next-upgrade/batch.js')
      ;(async () => {
        const live = { status: 'created', expiresAt: new Date(Date.now() + 7200000) }
        Snapshot.get = async () => live
        assert.equal(await reusableSnapshot('live'), live)
        Snapshot.get = async () => ({ ...live, expiresAt: new Date(Date.now() - 1) })
        assert.equal(await reusableSnapshot('expired'), null)
        Snapshot.get = async () => { throw new APIError(new Response(null, { status: 404 })) }
        assert.equal(await reusableSnapshot('deleted'), null)
        for (const status of [401, 403, 429, 500]) {
          Snapshot.get = async () => { throw new APIError(new Response(null, { status })) }
          await assert.rejects(() => reusableSnapshot('unavailable'), APIError)
        }
      })().catch(error => { console.error(error); process.exitCode = 1 })
    `
    expect(
      execFileSync(process.execPath, ['-e', program], {
        cwd: join(__dirname, '../../..'),
        encoding: 'utf8',
      })
    ).toContain('preparing a replacement')
  })

  // Windows does not deliver POSIX process-group signals to child handlers.
  // @force-gate !windows
  it('waits for native capture after cancellation before returning', () => {
    const program = `
      const assert = require('node:assert/strict')
      const fs = require('node:fs')
      const os = require('node:os')
      const path = require('node:path')
      const { runNative } = require('./evals/next-upgrade/run.js')
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-cancel-'))
      const receipt = path.join(directory, 'capture')
      const child = "process.on('SIGINT', () => { require('node:fs').writeFileSync(" + JSON.stringify(receipt) + ", 'complete'); process.exit(130) }); process.kill(process.ppid, 'SIGTERM'); setInterval(() => {}, 1000)"
      runNative(process.execPath, ['-e', child], { stdio: 'ignore' })
        .then(code => { assert.equal(code, 130); assert.equal(fs.readFileSync(receipt, 'utf8'), 'complete') })
        .catch(error => { console.error(error); process.exitCode = 1 })
        .finally(() => fs.rmSync(directory, { recursive: true, force: true }))
    `
    // The real child must handle the forwarded signal and exit itself. A parent
    // that returns early leaves it running and this bounded probe fails.
    expect(
      execFileSync(process.execPath, ['-e', program], {
        cwd: join(__dirname, '../../..'),
        encoding: 'utf8',
        timeout: 10000,
      })
    ).toHaveLength(0)
  })
})

describe('candidate upgrade evidence', () => {
  it('requires the requested policy and successful command completion', () => {
    const program = `
      require('tsx/cjs')
      const { verifyRun } = require('./evals/next-upgrade/verifier/verify.ts')
      const trials = [
        { args: ['upgrade', '--agent=security'], code: 0, expected: true },
        { args: ['upgrade', '--agent'], code: 0, expected: true },
        { args: ['upgrade', '--agent', 'latest'], code: 0, expected: false },
        { args: ['upgrade', '--agent=security', '--help'], code: 0, expected: false },
        { args: ['upgrade', '--agent=security', '--agent=latest'], code: 0, expected: false },
        { args: ['upgrade', '--agent=security'], code: 1, expected: false },
        { args: ['upgrade', '--agent=security'], code: null, expected: false },
      ]
      ;(async () => {
        for (const trial of trials) {
          const invocation = { args: trial.args, version: '16.5.0-canary.3', executable: '/tmp/next-upgrade-eval/next/node_modules/next/dist/bin/next' }
          const completion = { args: trial.args, version: invocation.version, exitCode: trial.code }
          const artifact = { trees: [], capturedAt: '', evidence: {
            'invocations.jsonl': JSON.stringify(invocation),
            'commands.jsonl': JSON.stringify(completion),
          } }
          const verdict = await verifyRun('security-same-major', { kind: 'direct', policy: 'security' }, artifact, { result: {} }, '/tmp/unused')
          if (verdict.checks['candidate-cli'].passed !== trial.expected) {
            throw new Error(JSON.stringify(trial))
          }
        }
      })().catch(error => { console.error(error); process.exitCode = 1 })
    `
    expect(
      execFileSync(process.execPath, ['-e', program], {
        cwd: join(__dirname, '../../..'),
        encoding: 'utf8',
      }).trim()
    ).toBe('')
  })
})

describe('fixed judge execution boundary', () => {
  const {
    completedJudge,
  } = require('../../../evals/next-upgrade/verifier/judge/EVAL')

  it('accepts a completed semantic failure while rejecting runner and parser failures', () => {
    const verdict = { pass: false, reason: 'Final response omitted the notice' }
    const raw = JSON.stringify(verdict)
    expect(completedJudge({ ok: true, agentExitCode: 0 }, raw)).toEqual(verdict)
    expect(() => completedJudge({ ok: false, agentExitCode: 1 }, raw)).toThrow()
    expect(() => completedJudge({ ok: true, agentExitCode: 0 }, null)).toThrow()
  })

  it('rejects malformed raw verdicts before native boolean coercion', () => {
    const runner = { ok: true, agentExitCode: 0 }
    for (const pass of ['false', 'true', 0, 1, null]) {
      expect(() =>
        completedJudge(runner, JSON.stringify({ pass, reason: 'Malformed' }))
      ).toThrow()
    }
    for (const raw of [
      'not JSON',
      '{"pass":true}',
      '{"pass":false,"reason":1}',
    ]) {
      expect(() => completedJudge(runner, raw)).toThrow()
    }
    expect(
      completedJudge(
        runner,
        'Verdict: ```json\n{"pass":true,"reason":"Notice mentioned"}\n```'
      )
    ).toEqual({ pass: true, reason: 'Notice mentioned' })
  })
})

describe('delivered TypeScript coverage', () => {
  it('checks imported files while rejecting unchecked files and actual type errors', () => {
    // Use the real compiler and grader, isolating installation and Vitest lifecycle.
    const program = `
      require('tsx/cjs')
      const assert = require('node:assert/strict')
      const fs = require('node:fs'), os = require('node:os'), path = require('node:path')
      const Module = require('node:module')
      const app = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'upgrade-types-')))
      let typecheck
      const load = Module._load
      Module._load = function (name, ...args) {
        if (name === 'vitest') {
          return { beforeAll: () => {}, afterAll: () => {}, vi: {},
            test: (name, body) => { if (name === 'typecheck') typecheck = body },
            expect: value => ({ toBe: expected => assert.equal(value, expected),
              toBeNull: () => assert.equal(value, null), toBeTruthy: () => assert.ok(value) }) }
        }
        return load.call(this, name, ...args)
      }
      try {
        for (const dir of ['app', 'lib', 'node_modules']) fs.mkdirSync(path.join(app, dir))
        fs.symlinkSync(path.dirname(require.resolve('typescript/package.json')), path.join(app, 'node_modules/typescript'), 'junction')
        fs.writeFileSync(path.join(app, 'package.json'), JSON.stringify({ scripts: { typecheck: 'tsc --noEmit' } }))
        fs.writeFileSync(path.join(app, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, noEmit: true }, files: ['app/page.ts'] }))
        fs.writeFileSync(path.join(app, 'app/page.ts'), "import { value } from '../lib/value'; export const page: string = value")
        fs.writeFileSync(path.join(app, 'lib/value.ts'), "export const value: string = 'valid'")
        process.env.NEXT_UPGRADE_VERIFY_APP = app
        process.env.NEXT_UPGRADE_VERIFY_REPORT = path.join(app, 'report.json')
        require('./evals/next-upgrade/verifier/upgrade.ts').upgradeChecks('unused')
      } finally {
        Module._load = load
      }
      ;(async () => {
        await typecheck()
        fs.writeFileSync(path.join(app, 'lib/value.ts'), 'export const value: string = 42')
        await assert.rejects(typecheck, error => error.stdout.includes('value.ts'))
        fs.writeFileSync(path.join(app, 'lib/value.ts'), "export const value: string = 'valid'")
        fs.writeFileSync(path.join(app, 'lib/unchecked.ts'), "export const unchecked = 'missing from program'")
        await assert.rejects(typecheck, /false.*true|AssertionError/)
      })().catch(error => { console.error(error); process.exitCode = 1 })
        .finally(() => fs.rmSync(app, { recursive: true, force: true }))
    `
    expect(
      execFileSync(process.execPath, ['-e', program], {
        cwd: join(__dirname, '../../..'),
        encoding: 'utf8',
        timeout: 30000,
      })
    ).toHaveLength(0)
  })
})

describe('prepared candidate and cleanup ownership', () => {
  const {
    validatePreparedCandidate,
    cleanupOwned,
  } = require('../../../evals/next-upgrade/run.js')

  it('rejects stale source or package provenance before remote execution', () => {
    const expected = {
      sourceRevision: 'current',
      originalVersion: '16.5.0-canary.3',
      nextSha256: 'package',
    }
    const provenance = {
      ...expected,
      declaredVersion: '16.5.0',
      compiledVersion: 'Next.js v16.5.0',
    }
    expect(() => validatePreparedCandidate(provenance, expected)).not.toThrow()
    expect(() =>
      validatePreparedCandidate(
        { ...provenance, sourceRevision: 'old' },
        expected
      )
    ).toThrow()
    expect(() =>
      validatePreparedCandidate(
        { ...provenance, nextSha256: 'other' },
        expected
      )
    ).toThrow()
  })

  it('attempts every owned cleanup and reports failures together', async () => {
    const calls: string[] = []
    await expect(
      cleanupOwned([
        async () => {
          calls.push('toolchain')
          throw new Error('delete failed')
        },
        async () => {
          calls.push('verifier')
        },
        async () => {
          calls.push('temporary')
        },
      ])
    ).rejects.toThrow('cleanup')
    expect(calls).toEqual(['toolchain', 'verifier', 'temporary'])
  })
})
