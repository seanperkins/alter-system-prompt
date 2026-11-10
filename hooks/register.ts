import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { ContextBlock, Injected, Section } from '../types'

// Claude Code's system prompt tells the model to keep temporary files in a
// per-session scratchpad under /private/tmp/claude-<uid>/.../scratchpad. We
// keep scratch output in the project's own .tmp/<task>/ folder instead, which
// is gitignored and easy to find. This mod rewrites the built-in instructions
// to say so, refuses writes into the scratchpad, and adds /prompt-dump to save
// what the model was last sent. See README.md for why.

// The session scratchpad: /private/tmp/claude-501/<project>/<session-uuid>/scratchpad
const SCRATCHPAD = /\/claude-\d+\/[^/\s]+\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/scratchpad(?=\/|\s|$|['"`])/

const tmpRule = (root: string) =>
  `Temporary files: put scripts, probes, captures, screenshots, logs and any other scratch output in ${root}/.tmp/<unique-task-dir>/ (create it with \`mktemp -d ${root}/.tmp/<task>-XXXX\` and confirm \`.tmp/\` is gitignored). Do not use the session scratchpad under /private/tmp or /tmp. When you name one of these files to the user, give its full absolute path.`

const REWRITES: { find: RegExp; replace: (root: string) => string }[] = [
  // Environment section: " - Scratchpad directory: /private/tmp/... — always use it ..."
  {
    find: /^([ \t]*-[ \t]*)Scratchpad directory:[^\n]*$/m,
    replace: root => `$1${tmpRule(root)}`,
  },
  // Sandbox section: "For temporary files, always use the `$TMPDIR` environment variable. ..."
  {
    find: /For temporary files, always use the `\$TMPDIR` environment variable\.[^\n]*/,
    replace: root =>
      `For temporary files, use ${root}/.tmp/<unique-task-dir>/ (the project folder is writable in the sandbox). Use \`$TMPDIR\` only for the one command whose tool requires system temp storage, such as a Unix socket path, and say why.`,
  },
]

function rewrite(text: string, root: string): string {
  let out = text
  for (const { find, replace } of REWRITES) out = out.replace(find, replace(root))
  return out
}

const deny = (root: string, path: string): { deny: string } => ({
  deny: `alter-system-prompt: ${path} is in the session scratchpad. Put scratch files in ${root}/.tmp/<unique-task-dir>/ instead.`,
})

// What /prompt-dump writes out, captured from the engine's real renders (a
// replay would lack the tools and traits of a real request). Kept in session
// state, not module variables, so a reload of the mod doesn't lose them.
const systemBefore = atom({ plugin: 'alter-system-prompt', key: 'systemBefore' } as const, [] as Section[], { shape: 'sections-1' })
const systemAfter = atom({ plugin: 'alter-system-prompt', key: 'systemAfter' } as const, [] as Section[], { shape: 'sections-1' })
const context = atom({ plugin: 'alter-system-prompt', key: 'context' } as const, [] as ContextBlock[], { shape: 'blocks-1' })
const injectedLog = atom({ plugin: 'alter-system-prompt', key: 'injected' } as const, [] as Injected[], { shape: 'injected-1' })

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'prompt-dump',
      description: 'Save the composed system prompt (before and after this plugin) to .tmp/',
    })
    return next(e)
  })

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    const root = await $.session.root()
    const sections = composed.sections.map(s => {
      const text = rewrite(s.text, root)
      return text === s.text ? s : { ...s, text }
    })
    await update($, systemBefore, () => [...composed.sections])
    await update($, systemAfter, () => sections)
    return { ...composed, sections }
  })

  on('prompt.context', async ($, e, next) => {
    const result = await next(e)
    await update($, context, () => [...result.blocks])
    return result
  })

  // Tool descriptions (Bash carries the sandbox text) get the same rewrite.
  on('tool.describe', async ($, e, next) => {
    const described = await next(e)
    const root = await $.session.root()
    const description = rewrite(described.description, root)
    return description === described.description ? described : { ...described, description }
  })

  // Messages the engine injects on its own (the sandbox notice arrives this
  // way, re-sent mid-session) get it too.
  on('prompt.attachment', async ($, e, next) => {
    const injected = await next(e)
    if (injected.text === null) return injected
    const text = rewrite(injected.text, await $.session.root())
    const row = { type: e.type, origin: e.origin?.kind ?? '?', before: injected.text, after: text }
    await update($, injectedLog, list => [...(list ?? []), row].slice(-60))
    return text === injected.text ? injected : { ...injected, text }
  })

  on('tool.call', { tool: 'Write' }, async ($, e, next) => {
    if (!SCRATCHPAD.test(e.file_path)) return next(e)
    return deny(await $.session.root(), e.file_path)
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'Edit' }, async ($, e, next) => {
    if (!SCRATCHPAD.test(e.file_path)) return next(e)
    return deny(await $.session.root(), e.file_path)
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'NotebookEdit' }, async ($, e, next) => {
    if (!SCRATCHPAD.test(e.notebook_path)) return next(e)
    return deny(await $.session.root(), e.notebook_path)
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const command = String(e.command ?? '')
    const hit = command.match(SCRATCHPAD)
    return hit ? deny(await $.session.root(), hit[0]) : next(e)
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'prompt-dump' }, async $ => {
    const root = await $.session.root()
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const dir = `${root}/.tmp/prompt-dump-${stamp}`
    const lastOriginal = (await read($, systemBefore)) ?? []
    const lastRewritten = (await read($, systemAfter)) ?? []
    const contextBlocks = (await read($, context)) ?? []
    const attachments = (await read($, injectedLog)) ?? []
    const render = (sections: readonly Section[]) =>
      sections
        .map(s => `<!-- section: ${s.id} | ${s.scope} | ${s.text.length} chars -->\n\n${s.text}`)
        .join('\n\n')
    await $.fs.write(`${dir}/system-before.md`, render(lastOriginal))
    await $.fs.write(`${dir}/system-after.md`, render(lastRewritten))
    await $.fs.write(
      `${dir}/context.md`,
      contextBlocks.map(b => `<!-- block: ${b.name} | ${b.text.length} chars -->\n\n${b.text}`).join('\n\n'),
    )
    await $.fs.write(
      `${dir}/attachments.md`,
      attachments
        .map(
          a =>
            `<!-- attachment: ${a.type} | origin ${a.origin} | ${a.before.length} chars${a.after === a.before ? '' : ' | REWRITTEN'} -->\n\n${a.after}`,
        )
        .join('\n\n'),
    )
    const rows = [
      ...lastRewritten.map(s => `system\t${s.id}\t${s.text.length}`),
      ...contextBlocks.map(b => `context\t${b.name}\t${b.text.length}`),
      ...attachments.map(a => `attachment\t${a.type}\t${a.after.length}`),
    ]
    await $.fs.write(`${dir}/sections.tsv`, ['where\tid\tchars', ...rows].join('\n'))
    return {
      text: `Prompt saved to ${dir}/ (system-before.md, system-after.md, context.md, attachments.md, sections.tsv)`,
    }
  })
}
