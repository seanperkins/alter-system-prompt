import { expect, test } from 'claude-code/testing'

const ROOT = '/Users/me/sites/demo'
const SCRATCH =
  '/private/tmp/claude-501/-Users-me-sites-demo/23624592-9be9-4ab0-ab9f-1cd207455600/scratchpad'

// Nothing sits beneath the plugin: each hook here stands for the engine.
function engine(on: Parameters<Parameters<typeof test>[1]>[1]) {
  on('session.root', () => ({ value: ROOT }))
  on('tool.call', () => ({ result: {} }))
}

test('a Write into the session scratchpad is refused, pointing at .tmp', async ($, on) => {
  engine(on)
  const ran = await $.tool.call({ tool: 'Write', file_path: `${SCRATCH}/a.txt`, content: 'x' })
  expect(ran.deny).toContain(`${ROOT}/.tmp/`)
})

test('a Write into the project .tmp goes through', async ($, on) => {
  engine(on)
  const ran = await $.tool.call({ tool: 'Write', file_path: `${ROOT}/.tmp/t-1/a.txt`, content: 'x' })
  expect(ran.deny).toBeUndefined()
})

test('a Bash command that touches the scratchpad is refused', async ($, on) => {
  engine(on)
  const ran = await $.tool.call({ tool: 'Bash', command: `ls ${SCRATCH}/` })
  expect(ran.deny).toContain('session scratchpad')
})

test('an unrelated Bash command goes through', async ($, on) => {
  engine(on)
  const ran = await $.tool.call({ tool: 'Bash', command: 'ls /private/tmp' })
  expect(ran.deny).toBeUndefined()
})

test('the scratchpad line in the system prompt is rewritten to the project .tmp', async ($, on) => {
  engine(on)
  on('prompt.compose', () => ({
    sections: [
      {
        id: 'env',
        scope: 'session',
        text: `# Environment\n - Scratchpad directory: ${SCRATCH} — always use it for temporary files instead of /tmp.\n - Platform: darwin`,
      },
    ],
  }))
  const { sections } = await $.prompt.compose({
    model: 'claude-opus-5-5',
    promptModel: 'claude-opus-5-5',
    surfaces: ['terminal'],
    tools: ['Bash', 'Write'],
    outputStyle: null,
    traits: [],
  })
  const text = sections[0]!.text
  expect(text).toContain(`${ROOT}/.tmp/<unique-task-dir>/`)
  expect(text).not.toContain('Scratchpad directory:')
  expect(text).toContain(' - Platform: darwin')
})

test('the sandbox $TMPDIR instruction is rewritten', async ($, on) => {
  engine(on)
  on('prompt.attachment', () => ({
    text: 'For temporary files, always use the `$TMPDIR` environment variable. Do not write to /tmp.',
  }))
  const { text } = await $.prompt.attachment({ type: 'sandbox', text: '', origin: { kind: 'engine' } } as never)
  expect(text).toContain(`${ROOT}/.tmp/<unique-task-dir>/`)
})
