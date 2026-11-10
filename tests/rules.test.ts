import { expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { PRESETS as BUILT_IN } from '../hooks/presets'

const HOME = '/Users/me'
const ROOT = '/Users/me/sites/demo'
const GLOBAL = `${HOME}/.claude/alter-system-prompt.json`
const PROJECT = `${ROOT}/.claude/alter-system-prompt.json`
const SCRATCH = '/private/tmp/claude-501/-Users-me-sites-demo/00000000-1111-2222-3333-444444444444/scratchpad'

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
function engine(on: On, files: Files, readFile?: (path: string) => string) {
  on('session.root', () => ({ value: ROOT }))
  on('env.get', (_, e) => ({ value: e.name === 'HOME' ? HOME : undefined }))
  on('fs.exists', (_, e) => ({ value: e.path in files }))
  on('fs.read', (_, e) => {
    if (readFile) return { value: readFile(e.path) }
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

test('a rule can rewrite or drop any section: nothing is off limits', async ($, on) => {
  engine(on, {
    [GLOBAL]: {
      rules: [
        { id: 'strip', findRegex: 'IMPORTANT: Assist with authorized security testing[^\\n]*', replace: 'Mine.' },
        { id: 'drop', dropSection: 'user_privacy' },
        { id: 'rewrite', section: 'action_caution', find: 'confirm first', replace: 'tell me after' },
      ],
    },
  })
  on('prompt.compose', () => ({
    sections: [
      { id: 'lean_body', scope: 'shared', text: 'You are an agent.\nIMPORTANT: Assist with authorized security testing, defensive security.' },
      { id: 'user_privacy', scope: 'session', text: 'Treat the user as private.' },
      { id: 'action_caution', scope: 'session', text: 'For risky actions, confirm first.' },
    ],
  }))
  const { sections } = await $.prompt.compose(COMPOSE)
  expect(sections.map(s => s.id)).toEqual(['lean_body', 'action_caution'])
  expect(sections[0]!.text).toBe('You are an agent.\nMine.')
  expect(sections[1]!.text).toBe('For risky actions, tell me after.')
  const { text } = await $.command.run({ command: 'alter-prompt', args: '' } as never)
  for (const id of ['strip', 'drop', 'rewrite']) expect(text).toContain(`- ${id}: changed 1x`)
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

test('a block pattern with the g flag matches every call, not every other one', async ($, on) => {
  engine(on, { [GLOBAL]: { block: [{ id: 'no-rm', tools: ['Bash'], pattern: 'rm -rf', flags: 'g' }] } })
  for (let i = 0; i < 3; i++) {
    const ran = await $.tool.call({ tool: 'Bash', command: 'rm -rf build' })
    expect(ran.deny).toContain('no-rm')
  }
})

test('a rewrite still goes out when its bookkeeping write fails', async ($, on) => {
  engine(on, { [GLOBAL]: { rules: [{ id: 'r1', find: 'scratchpad', replace: 'project .tmp' }] } })
  on('state.set', () => {
    throw new Error('write collided')
  })
  on('prompt.attachment', () => ({ text: 'use the scratchpad' }))
  const { text } = await $.prompt.attachment({ type: 'environment', text: '', origin: { kind: 'engine' } } as never)
  expect(text).toBe('use the project .tmp')
})

// The class of bug these guard against: bookkeeping (state writes) reaching
// the rewrite path. Rewrites must come out right however many hooks run at
// once and whatever the state store does.

test('50 injected messages at once are all rewritten, while every state write collides', async ($, on) => {
  engine(on, { [GLOBAL]: { rules: [{ id: 'r1', find: 'scratchpad', replace: 'project .tmp' }] } })
  // What a collision looks like: someone else wrote first, so this write is
  // refused. The state library retries, then gives up by throwing.
  let version = 0
  on('state.set', () => ({ value: { isSet: false as const, version: ++version } }))
  on('prompt.attachment', (_, e) => ({ text: `message ${(e as { type: string }).type}: use the scratchpad` }))
  const results = await Promise.all(
    Array.from({ length: 50 }, (_, i) =>
      $.prompt.attachment({ type: `m${i}`, text: '', origin: { kind: 'engine' } } as never),
    ),
  )
  results.forEach((r, i) => expect(r.text).toBe(`message m${i}: use the project .tmp`))
  const { text } = await $.command.run({ command: 'alter-prompt', args: '' } as never)
  expect(text).toContain('- r1: changed 50x')
})

test('a rewrite does not wait on the state store, even one that never answers', async ($, on) => {
  engine(on, { [GLOBAL]: { rules: [{ id: 'r1', find: 'scratchpad', replace: 'project .tmp' }] } })
  on('state.get', () => new Promise(() => {}))
  on('state.set', () => new Promise(() => {}))
  on('prompt.attachment', () => ({ text: 'use the scratchpad' }))
  on('prompt.compose', () => ({ sections: [{ id: 's', scope: 'session', text: 'the scratchpad' }] }))
  const [attachment, composed] = await Promise.all([
    $.prompt.attachment({ type: 'environment', text: '', origin: { kind: 'engine' } } as never),
    $.prompt.compose(COMPOSE),
  ])
  expect(attachment.text).toBe('use the project .tmp')
  expect(composed.sections[0]!.text).toBe('the project .tmp')
})

test('20 blocked tool calls at once are all refused', async ($, on) => {
  engine(on, { [GLOBAL]: { block: [{ id: 'no-rm', tools: ['Bash'], pattern: 'rm -rf' }] } })
  let version = 0
  on('state.set', () => ({ value: { isSet: false as const, version: ++version } }))
  const results = await Promise.all(
    Array.from({ length: 20 }, () => $.tool.call({ tool: 'Bash', command: 'rm -rf build' })),
  )
  for (const r of results) expect(r.deny).toContain('no-rm')
})

test('a rule file that cannot be read is retried on the next message, not cached as empty', async ($, on) => {
  let reads = 0
  const files: Files = { [GLOBAL]: { rules: [{ id: 'r1', find: 'a', replace: 'b' }] } }
  engine(on, files, path => {
    reads++
    if (reads === 1) throw new Error('EBUSY')
    return JSON.stringify(files[path])
  })
  on('prompt.compose', () => ({ sections: [{ id: 's', scope: 'session', text: 'a' }] }))
  const first = await $.prompt.compose(COMPOSE)
  expect(first.sections[0]!.text).toBe('a')
  const second = await $.prompt.compose(COMPOSE)
  expect(second.sections[0]!.text).toBe('b')
})

test('/prompt-dump saves injected messages before and after the rules, and names the rewritten ones', async ($, on) => {
  const files: Files = { [GLOBAL]: await readPreset('project-tmp.json') }
  engine(on, files)
  on('fs.write', (_, e) => {
    files[e.path] = e.text
    return { value: undefined }
  })
  on('prompt.compose', () => ({ sections: [{ id: 's', scope: 'session', text: 'hello' }] }))
  on('prompt.attachment', (_, e) => ({
    text:
      (e as { type: string }).type === 'environment'
        ? `# Environment\n - Scratchpad directory: ${SCRATCH} — always use it for temporary files.`
        : 'Today is Tuesday.',
  }))
  await $.prompt.compose(COMPOSE)
  await $.prompt.attachment({ type: 'environment', text: '', origin: { kind: 'engine' } } as never)
  await $.prompt.attachment({ type: 'date', text: '', origin: { kind: 'engine' } } as never)
  const { text } = await $.command.run({ command: 'prompt-dump', args: '' } as never)
  const saved = (name: string) => {
    const path = Object.keys(files).find(p => p.startsWith(`${ROOT}/.tmp/prompt-dump-`) && p.endsWith(`/${name}`))
    return path ? (files[path] as string) : undefined
  }
  const before = saved('attachments-before.md')!
  const after = saved('attachments-after.md')!
  expect(before).toContain('Scratchpad directory:')
  expect(before).not.toContain('Temporary files: put scripts')
  expect(after).toContain('Temporary files: put scripts')
  expect(after).not.toContain('Scratchpad directory:')
  for (const dump of [before, after]) {
    expect(dump.split('\n')[0]).toMatch(/^<!-- attachment: environment \| origin engine \| \d+ chars \| REWRITTEN -->$/)
    expect(dump).toContain('<!-- attachment: date | origin engine | 17 chars -->')
    expect(dump).toContain('Today is Tuesday.')
  }
  expect(saved('attachments.md')).toBe(undefined)
  expect(text).toContain('1 of 2 injected messages rewritten (environment)')
})
