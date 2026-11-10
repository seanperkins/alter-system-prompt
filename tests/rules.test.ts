import { expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { PRESETS as BUILT_IN } from '../hooks/presets'

const HOME = '/Users/me'
const ROOT = '/Users/me/sites/demo'
const GLOBAL = `${HOME}/.claude/alter-system-prompt.json`
const PROJECT = `${ROOT}/.claude/alter-system-prompt.json`
const SCRATCH = '/private/tmp/claude-501/-Users-me-sites-demo/23624592-9be9-4ab0-ab9f-1cd207455600/scratchpad'

const COMPOSE = {
  model: 'claude-opus-5-5',
  promptModel: 'claude-opus-5-5',
  surfaces: ['terminal'],
  tools: ['Bash', 'Write'],
  outputStyle: null,
  traits: [],
} as const

type Files = Record<string, unknown>

// Nothing sits beneath the plugin: each hook here stands for the engine,
// with the rule files given as an in-memory file system.
function engine(on: On, files: Files) {
  on('session.root', () => ({ value: ROOT }))
  on('env.get', (_, e) => ({ value: e.name === 'HOME' ? HOME : undefined }))
  on('fs.exists', (_, e) => ({ value: e.path in files }))
  on('fs.read', (_, e) => {
    const content = files[e.path]
    return { value: typeof content === 'string' ? content : JSON.stringify(content) }
  })
  on('tool.call', () => ({ result: {} }))
}

async function readPreset(name: string): Promise<unknown> {
  const { description: _, ...file } = BUILT_IN[name.replace(/\.json$/, '')]!
  return file
}

test('with no rule files, nothing changes and nothing is blocked', async ($, on) => {
  engine(on, {})
  on('prompt.compose', () => ({ sections: [{ id: 'intro', scope: 'shared', text: 'Hello.' }] }))
  const { sections } = await $.prompt.compose(COMPOSE)
  expect(sections).toEqual([{ id: 'intro', scope: 'shared', text: 'Hello.' }])
  const ran = await $.tool.call({ tool: 'Write', file_path: `${SCRATCH}/a.txt`, content: 'x' })
  expect(ran.deny).toBeUndefined()
})

test('a literal find/replace rewrites the system prompt, with {projectRoot} filled in', async ($, on) => {
  engine(on, {
    [GLOBAL]: { rules: [{ id: 'r1', find: 'use /tmp', replace: 'use {projectRoot}/.tmp' }] },
  })
  on('prompt.compose', () => ({ sections: [{ id: 'env', scope: 'session', text: 'Always use /tmp. Really.' }] }))
  const { sections } = await $.prompt.compose(COMPOSE)
  expect(sections[0]!.text).toBe(`Always use ${ROOT}/.tmp. Really.`)
})

test('a project rule with the same id replaces the user rule', async ($, on) => {
  engine(on, {
    [GLOBAL]: { rules: [{ id: 'r1', find: 'a', replace: 'GLOBAL' }] },
    [PROJECT]: { rules: [{ id: 'r1', find: 'a', replace: 'PROJECT' }] },
  })
  on('prompt.compose', () => ({ sections: [{ id: 's', scope: 'session', text: 'a' }] }))
  const { sections } = await $.prompt.compose(COMPOSE)
  expect(sections[0]!.text).toBe('PROJECT')
})

test('addSection adds a section and dropSection removes one', async ($, on) => {
  engine(on, {
    [GLOBAL]: {
      rules: [
        { id: 'add', addSection: 'Always answer in British English.' },
        { id: 'drop', dropSection: 'heron_extra' },
      ],
    },
  })
  on('prompt.compose', () => ({
    sections: [
      { id: 'intro', scope: 'shared', text: 'Hi.' },
      { id: 'heron_extra', scope: 'session', text: 'Remove me.' },
    ],
  }))
  const { sections } = await $.prompt.compose(COMPOSE)
  expect(sections.map(s => s.id)).toEqual(['intro', 'alter-system-prompt:add'])
  expect(sections[1]!.text).toBe('Always answer in British English.')
})

test('a rule cannot remove protected safety text', async ($, on) => {
  engine(on, {
    [GLOBAL]: {
      rules: [
        { id: 'strip', findRegex: 'IMPORTANT: Assist with authorized security testing[^\\n]*', replace: '' },
        { id: 'drop', dropSection: 'user_privacy' },
      ],
    },
  })
  const security = 'IMPORTANT: Assist with authorized security testing, defensive security.'
  on('prompt.compose', () => ({
    sections: [
      { id: 'lean_body', scope: 'shared', text: `You are an agent.\n${security}` },
      { id: 'user_privacy', scope: 'session', text: 'Treat the user as private.' },
    ],
  }))
  const { sections } = await $.prompt.compose(COMPOSE)
  expect(sections[0]!.text).toContain(security)
  expect(sections.map(s => s.id)).toContain('user_privacy')
})

test('append on a tool description only touches that tool', async ($, on) => {
  engine(on, { [GLOBAL]: await readPreset('artifact-mockups.json') })
  on('tool.describe', (_, e) => ({ description: `${e.tool} does things.` }))
  const artifact = await $.tool.describe({ tool: 'Artifact', description: '' } as never)
  expect(artifact.description).toContain('Mockups are local files')
  const bash = await $.tool.describe({ tool: 'Bash', description: '' } as never)
  expect(bash.description).toBe('Bash does things.')
})

test('project-tmp preset: the scratchpad line is rewritten in an injected message', async ($, on) => {
  engine(on, { [GLOBAL]: await readPreset('project-tmp.json') })
  on('prompt.attachment', () => ({
    text: `# Environment\n - Scratchpad directory: ${SCRATCH} — always use it for temporary files.\n - Platform: darwin`,
  }))
  const { text } = await $.prompt.attachment({ type: 'environment', text: '', origin: { kind: 'engine' } } as never)
  expect(text).toContain(` - Temporary files: put scripts`)
  expect(text).toContain(`${ROOT}/.tmp/<unique-task-dir>/`)
  expect(text).not.toContain('Scratchpad directory:')
  expect(text).toContain(' - Platform: darwin')
})

test('project-tmp preset: the sandbox $TMPDIR line is rewritten, keeping a literal $TMPDIR', async ($, on) => {
  engine(on, { [GLOBAL]: await readPreset('project-tmp.json') })
  on('prompt.attachment', () => ({
    text: 'For temporary files, always use the `$TMPDIR` environment variable. Do not write to /tmp.',
  }))
  const { text } = await $.prompt.attachment({ type: 'sandbox_instructions', text: '', origin: { kind: 'engine' } } as never)
  expect(text).toContain(`For temporary files, use ${ROOT}/.tmp/<unique-task-dir>/`)
  expect(text).toContain('Use `$TMPDIR` only for')
})

test('file contents shown to the model are never rewritten', async ($, on) => {
  engine(on, { [GLOBAL]: await readPreset('project-tmp.json') })
  const original = 'For temporary files, always use the `$TMPDIR` environment variable.'
  on('prompt.attachment', () => ({ text: original }))
  const { text } = await $.prompt.attachment({ type: 'edited_text_file', text: '', origin: { kind: 'engine' } } as never)
  expect(text).toBe(original)
})

test('project-tmp preset: writes and commands that touch the scratchpad are refused', async ($, on) => {
  engine(on, { [GLOBAL]: await readPreset('project-tmp.json') })
  const write = await $.tool.call({ tool: 'Write', file_path: `${SCRATCH}/a.txt`, content: 'x' })
  expect(write.deny).toContain(`${ROOT}/.tmp/`)
  const bash = await $.tool.call({ tool: 'Bash', command: `ls ${SCRATCH}/` })
  expect(bash.deny).toContain('no-scratchpad-writes')
  const fine = await $.tool.call({ tool: 'Write', file_path: `${ROOT}/.tmp/t-1/a.txt`, content: 'x' })
  expect(fine.deny).toBeUndefined()
})

test('a broken rule is skipped and the others still apply', async ($, on) => {
  engine(on, {
    [GLOBAL]: {
      rules: [
        { id: 'bad', findRegex: '(unclosed', replace: 'x' },
        { id: 'two-actions', find: 'a', replace: 'b', append: 'c' },
        { id: 'good', find: 'hello', replace: 'goodbye' },
      ],
    },
  })
  on('prompt.compose', () => ({ sections: [{ id: 's', scope: 'session', text: 'hello' }] }))
  const { sections } = await $.prompt.compose(COMPOSE)
  expect(sections[0]!.text).toBe('goodbye')
})

test('/alter-prompt lists the rules and which ones matched', async ($, on) => {
  engine(on, { [GLOBAL]: { rules: [{ id: 'r1', find: 'a', replace: 'b' }, { id: 'r2', find: 'zzz', replace: 'y' }] } })
  on('prompt.compose', () => ({ sections: [{ id: 's', scope: 'session', text: 'a' }] }))
  await $.prompt.compose(COMPOSE)
  const { text } = await $.command.run({ command: 'alter-prompt', args: '' } as never)
  expect(text).toContain('- r1: changed 1x')
  expect(text).toContain('- r2: not matched yet')
})

test('/alter-prompt add copies a preset into the rules file, keeping existing rules', async ($, on) => {
  const files: Files = { [GLOBAL]: { rules: [{ id: 'mine', find: 'a', replace: 'b' }] } }
  engine(on, files)
  on('fs.write', (_, e) => {
    files[e.path] = e.text
    return { value: undefined }
  })
  const { text } = await $.command.run({ command: 'alter-prompt', args: 'add project-tmp' } as never)
  expect(text).toContain('Added preset "project-tmp"')
  const saved = JSON.parse(files[GLOBAL] as string)
  expect(saved.rules.map((r: { id: string }) => r.id)).toEqual(['mine', 'scratchpad-to-project-tmp', 'sandbox-tmpdir-to-project-tmp'])
  expect(saved.block.map((r: { id: string }) => r.id)).toEqual(['no-scratchpad-writes'])
  const denied = await $.tool.call({ tool: 'Write', file_path: `${SCRATCH}/a.txt`, content: 'x' })
  expect(denied.deny).toContain('no-scratchpad-writes')
})

test('a protected section can be added to but not rewritten', async ($, on) => {
  engine(on, {
    [GLOBAL]: {
      rules: [
        { id: 'rewrite', section: 'action_caution', find: 'confirm first', replace: 'just do it' },
        { id: 'extend', section: 'action_caution', append: 'Also: never force-push.' },
      ],
    },
  })
  on('prompt.compose', () => ({ sections: [{ id: 'action_caution', scope: 'session', text: 'For risky actions, confirm first.' }] }))
  const { sections } = await $.prompt.compose(COMPOSE)
  expect(sections[0]!.text).toBe('For risky actions, confirm first.\n\nAlso: never force-push.')
})

test('a block pattern with the g flag matches every call, not every other one', async ($, on) => {
  engine(on, { [GLOBAL]: { block: [{ id: 'no-rm', tools: ['Bash'], pattern: 'rm -rf', flags: 'g' }] } })
  for (let i = 0; i < 3; i++) {
    const ran = await $.tool.call({ tool: 'Bash', command: 'rm -rf build' })
    expect(ran.deny).toContain('no-rm')
  }
})
