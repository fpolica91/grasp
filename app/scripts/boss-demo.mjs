// One-shot UI demo/validation against the RUNNING app via the file bridge:
// health -> real grasp_fuzz_diff on the boss fixture (report + scenarios render live
// in the window) -> screenshot to disk. Run: node scripts/boss-demo.mjs [bossPath]
import { writeFileSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const dir = join(process.cwd(), '.grasp-harness')
const boss = process.argv[2] ?? `${process.env.HOME}/hydra-repos/boss`
const cmd = (id, kind, payload) => writeFileSync(join(dir, 'cmd.json'), JSON.stringify({ id, kind, payload }))
const wait = (id, ms = 20000) => new Promise((res, rej) => {
  const t0 = Date.now()
  const t = setInterval(() => {
    const p = join(dir, `out-${id}.json`)
    if (existsSync(p)) { clearInterval(t); res(JSON.parse(readFileSync(p, 'utf-8'))) }
    else if (Date.now() - t0 > ms) { clearInterval(t); rej(new Error(`timeout waiting for ${id} — is the app running with the harness build?`)) }
  }, 300)
})

cmd('d-health', 'health'); console.log('health:', JSON.stringify((await wait('d-health')).ok))
cmd('d-fuzz', 'tool', { name: 'grasp_fuzz_diff', workspace: boss, input: { entry: 'boss fixture (UI validation)', cases_file: '.grasp/tmp/grasp-ui-fixture.json' } })
const r = await wait('d-fuzz')
console.log('fuzz:', r.ok ? r.output.slice(0, 300) : r.error)
await new Promise((res) => setTimeout(res, 1200)) // let the renderer paint
cmd('d-shot', 'screenshot')
const s = await wait('d-shot')
console.log('screenshot:', s.path ?? s.error)
