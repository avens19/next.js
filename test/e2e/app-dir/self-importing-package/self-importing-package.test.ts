import { FileRef, nextTestSetup } from 'e2e-utils'
import { execFileSync } from 'child_process'
import { mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { gzipSync } from 'zlib'

// TODO(deploy-test-completion): Re-enable this suite in deploy mode.
// This test is skipped when deployed because the local tarball appears corrupted
// It also doesn't seem particularly useful to test when deployed
// @force-gate !deploy
describe('self-importing-package', () => {
  const overrideFiles: Record<string, FileRef> = {}
  let archiveDir: string

  beforeAll(async () => {
    archiveDir = await mkdtemp(join(tmpdir(), 'internal-pkg-'))
    const archivePath = join(archiveDir, 'internal-pkg.tgz')
    const tar = execFileSync('tar', ['-cf', '-', 'internal-pkg'], {
      cwd: __dirname,
    })
    await writeFile(archivePath, gzipSync(tar, { level: 1 }))
    overrideFiles['internal-pkg.tgz'] = new FileRef(archivePath)
  })

  afterAll(async () => {
    if (archiveDir) {
      await rm(archiveDir, { recursive: true, force: true })
    }
  })

  const { next } = nextTestSetup({
    files: __dirname,
    overrideFiles,
    dependencies: {
      'internal-pkg': 'file:./internal-pkg.tgz',
    },
  })

  it('should resolve self-imports in an external package', async () => {
    const $ = await next.render$('/')
    expect($('h1').text()).toBe('test abc')
  })
})
