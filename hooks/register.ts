import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { ContextBlock, Hit, Injected, Section } from '../types'
import { PRESETS } from './presets'

// alter-system-prompt: apply your own find/replace rules to the text Claude
// Code sends the model (system prompt sections, tool descriptions, and the
// messages it injects), and refuse tool calls that match a pattern.
//
// Rules live in JSON files, merged in this order (a later rule with the same
// id replaces an earlier one):
//   ~/.claude/alter-system-prompt.json          your rules, every project
//   <project>/.claude/alter-system-prompt.json  this project's rules
// See README.md for the format, and hooks/presets.ts for ready-made rules
// (/alter-prompt add <name> copies one into your rules file).

// ---------------------------------------------------------------- rules ---

type Where = 'system' | 'tools' | 'attachments'

type RuleFile = {
  rules?: RawRule[]
  block?: RawBlock[]
}

type RawRule = {
  id: string
  description?: string
  enabled?: boolean
  in?: Where | Where[]
  section?: string
  tool?: string
  attachment?: string
  find?: string
  findRegex?: string
  flags?: string
  replace?: string
  append?: string
  prepend?: string
  addSection?: string
  dropSection?: string
}

type RawBlock = {
  id: string
  enabled?: boolean
  tools?: string[]
  pattern: string
  flags?: string
  message?: string
}

type Rule = RawRule & { where: Set<Where>; regex: RegExp | null; source: string }
type Block = RawBlock & { regex: RegExp; source: string }
type Loaded = { rules: Rule[]; blocks: Block[]; files: string[]; errors: string[] }
type Vars = { projectRoot: string; home: string }
type Target = { where: Where; section?: string; tool?: string; attachment?: string }

const ALL: Where[] = ['system', 'tools', 'attachments']
const ACTIONS = ['replace', 'append', 'prepend', 'addSection', 'dropSection'] as const

// Messages that carry a file's contents, not instructions: never rewritten.
const FILE_ATTACHMENTS = new Set(['file', 'edited_text_file', 'compact_file_reference', 'pdf_reference'])

// Safety and policy text a rule may not remove. A rule whose result drops
// one of these is undone for that piece of text and reported as blocked.
// This is a guard against accidents, not a security boundary.
const PROTECTED_SECTIONS = new Set(['action_caution', 'user_privacy', 'heron_brook', 'endconv_deferred_hint'])
const PROTECTED_PHRASES = [
  'IMPORTANT: Assist with authorized security testing',
  'Refuse requests for destructive techniques',
  'Claude never publishes',
  'Usage Policy',
  'Do not suggest adding sensitive paths',
  'never infer pronouns',
]

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function compile(
  file: RuleFile,
  source: string,
  errors: string[],
): { rules: Rule[]; blocks: Block[] } {
  const rules: Rule[] = []
  const blocks: Block[] = []
  for (const raw of file.rules ?? []) {
    if (!raw || typeof raw.id !== 'string' || raw.id === '') {
      errors.push(`${source}: a rule has no "id"`)
      continue
    }
    if (raw.enabled === false) continue
    const actions = ACTIONS.filter(k => raw[k] !== undefined)
    if (actions.length !== 1) {
      errors.push(
        `${source}: rule "${raw.id}" needs exactly one of replace, append, prepend, addSection, dropSection`,
      )
      continue
    }
    if (raw.replace !== undefined && raw.find === undefined && raw.findRegex === undefined) {
      errors.push(`${source}: rule "${raw.id}" uses replace but has no find or findRegex`)
      continue
    }
    if (raw.dropSection !== undefined && PROTECTED_SECTIONS.has(raw.dropSection)) {
      errors.push(`${source}: rule "${raw.id}" may not drop the protected section "${raw.dropSection}"`)
      continue
    }
    let regex: RegExp | null = null
    try {
      if (raw.findRegex !== undefined) regex = new RegExp(raw.findRegex, raw.flags ?? '')
      else if (raw.find !== undefined) regex = new RegExp(escapeRegex(raw.find), raw.flags ?? '')
    } catch (error) {
      errors.push(`${source}: rule "${raw.id}" has a bad findRegex: ${String(error)}`)
      continue
    }
    const where = new Set<Where>(raw.in === undefined ? ALL : Array.isArray(raw.in) ? raw.in : [raw.in])
    rules.push({ ...raw, where, regex, source })
  }
  for (const raw of file.block ?? []) {
    if (!raw || typeof raw.id !== 'string' || typeof raw.pattern !== 'string') {
      errors.push(`${source}: a block entry needs "id" and "pattern"`)
      continue
    }
    if (raw.enabled === false) continue
    try {
      blocks.push({ ...raw, regex: new RegExp(raw.pattern, (raw.flags ?? '').replace('g', '')), source })
    } catch (error) {
      errors.push(`${source}: block "${raw.id}" has a bad pattern: ${String(error)}`)
    }
  }
  return { rules, blocks }
}

function byId<T extends { id: string }>(list: T[]): T[] {
  const seen = new Map<string, T>()
  for (const item of list) seen.set(item.id, item)
  return [...seen.values()]
}

// {projectRoot} and {home} in rule text, then $1..$9 from the match.
function fill(template: string, vars: Vars, groups: (string | undefined)[] = []): string {
  return template
    .replace(/\{projectRoot\}/g, vars.projectRoot)
    .replace(/\{home\}/g, vars.home)
    .replace(/\$(\d)/g, (_, n: string) => groups[Number(n)] ?? '')
}

function isProtectedLoss(before: string, after: string): boolean {
  return PROTECTED_PHRASES.some(p => before.includes(p) && !after.includes(p))
}

function applies(rule: Rule, target: Target): boolean {
  if (!rule.where.has(target.where)) return false
  if (rule.section !== undefined && rule.section !== target.section) return false
  if (rule.tool !== undefined && rule.tool !== target.tool) return false
  if (rule.attachment !== undefined && rule.attachment !== target.attachment) return false
  return true
}

/** Applies the text rules to one piece of text: the new text, and which rules changed it or were stopped. */
function applyRules(
  text: string,
  target: Target,
  rules: Rule[],
  vars: Vars,
): { text: string; changed: string[]; blocked: string[] } {
  let out = text
  const changed: string[] = []
  const blocked: string[] = []
  for (const rule of rules) {
    if (!applies(rule, target)) continue
    let next = out
    if (rule.replace !== undefined && rule.regex) {
      const replace = rule.replace
      next = out.replace(rule.regex, (match: string, ...rest: unknown[]) => {
        const groups = [match, ...rest.filter((x): x is string | undefined => typeof x !== 'number' && typeof x !== 'object')]
        return fill(replace, vars, groups)
      })
    } else if (rule.append !== undefined || rule.prepend !== undefined) {
      if (rule.regex && !new RegExp(rule.regex.source, rule.regex.flags.replace('g', '')).test(out)) continue
      const add = fill((rule.append ?? rule.prepend)!, vars)
      if (!out.includes(add)) next = rule.append !== undefined ? `${out}\n\n${add}` : `${add}\n\n${out}`
    }
    if (next === out) continue
    // Protected sections take added text only: nothing in them may be removed.
    const removes = target.section !== undefined && PROTECTED_SECTIONS.has(target.section) && !next.includes(out)
    if (removes || isProtectedLoss(out, next)) {
      blocked.push(rule.id)
      continue
    }
    out = next
    changed.push(rule.id)
  }
  return { text: out, changed, blocked }
}

// ---------------------------------------------------------------- state ---

// Captured from the engine's real renders for /prompt-dump and /alter-prompt;
// in session state so a reload of the mod does not lose them.
const systemBefore = atom(
  { plugin: 'alter-system-prompt', key: 'systemBefore' } as const,
  [] as Section[],
  { shape: 'sections-1' },
)
const systemAfter = atom(
  { plugin: 'alter-system-prompt', key: 'systemAfter' } as const,
  [] as Section[],
  { shape: 'sections-1' },
)
const context = atom({ plugin: 'alter-system-prompt', key: 'context' } as const, [] as ContextBlock[], {
  shape: 'blocks-1',
})
const injectedLog = atom({ plugin: 'alter-system-prompt', key: 'injected' } as const, [] as Injected[], {
  shape: 'injected-1',
})
const hits = atom({ plugin: 'alter-system-prompt', key: 'hits' } as const, [] as Hit[], { shape: 'hits-1' })

const STARTER = '{\n  "rules": [],\n  "block": []\n}\n'

// ---------------------------------------------------------------- hooks ---

// The rule files are read once per project root and cached; /alter-prompt
// reload clears the cache. A reload of the mod starts it over too.
let cache: { key: string; loaded: Promise<Loaded> } | null = null

async function vars($: EngineInterface): Promise<Vars> {
  return { projectRoot: await $.session.root(), home: (await $.env.get('HOME')) ?? '' }
}

function ruleFiles(v: Vars): string[] {
  return [`${v.home}/.claude/alter-system-prompt.json`, `${v.projectRoot}/.claude/alter-system-prompt.json`]
}

async function load($: EngineInterface): Promise<Loaded> {
  const v = await vars($)
  if (cache?.key === v.projectRoot) return cache.loaded
  const loaded = (async (): Promise<Loaded> => {
    const errors: string[] = []
    const found: string[] = []
    let rules: Rule[] = []
    let blocks: Block[] = []
    for (const path of ruleFiles(v)) {
      if (!(await $.fs.exists(path))) continue
      found.push(path)
      try {
        const compiled = compile(JSON.parse(await $.fs.read(path)) as RuleFile, path, errors)
        rules = rules.concat(compiled.rules)
        blocks = blocks.concat(compiled.blocks)
      } catch (error) {
        errors.push(`${path}: not valid JSON (${String(error)})`)
      }
    }
    if (errors.length)
      $.ui.toast(
        `alter-system-prompt: ${errors[0]}${errors.length > 1 ? ` (+${errors.length - 1} more: /alter-prompt)` : ''}`,
      )
    return { rules: byId(rules), blocks: byId(blocks), files: found, errors }
  })()
  cache = { key: v.projectRoot, loaded }
  return loaded
}

async function record($: EngineInterface, changed: string[], blocked: string[], where: string) {
  if (!changed.length && !blocked.length) return
  const at = new Date().toISOString()
  await update($, hits, list => {
    const next = [...(list ?? [])]
    const add = (id: string, kind: Hit['kind']) => {
      const i = next.findIndex(h => h.id === id && h.kind === kind)
      const row: Hit = { id, kind, where, count: (i >= 0 ? next[i]!.count : 0) + 1, last: at }
      if (i >= 0) next[i] = row
      else next.push(row)
    }
    for (const id of changed) add(id, 'changed')
    for (const id of blocked) add(id, 'blocked')
    return next
  })
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'prompt-dump',
      description:
        'Save what the model was last sent (system prompt before and after your rules, context, injected messages) to .tmp/',
    })
    await $.command.register({
      name: 'alter-prompt',
      description:
        'alter-system-prompt: list your rules and which matched; reload, init, presets, add <preset>',
      argumentHint: '[status|reload|init|presets|add <preset>]',
    })
    return next(e)
  })

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    const { rules } = await load($)
    const v = await vars($)
    const changed: string[] = []
    const blocked: string[] = []
    const drops = rules.filter(r => r.dropSection !== undefined && r.where.has('system'))
    for (const r of drops) if (composed.sections.some(s => s.id === r.dropSection)) changed.push(r.id)
    const dropped = new Set(drops.map(r => r.dropSection))
    const sections = composed.sections
      .filter(s => !dropped.has(s.id))
      .map(s => {
        const r = applyRules(s.text, { where: 'system', section: s.id }, rules, v)
        changed.push(...r.changed)
        blocked.push(...r.blocked)
        return r.text === s.text ? s : { ...s, text: r.text }
      })
    const added = rules
      .filter(r => r.addSection !== undefined && r.where.has('system'))
      .map(r => {
        changed.push(r.id)
        return { id: `alter-system-prompt:${r.id}`, text: fill(r.addSection!, v), scope: 'session' as const }
      })
    const result = [...sections, ...added]
    await update($, systemBefore, () => [...composed.sections])
    await update($, systemAfter, () => result)
    await record($, changed, blocked, 'system')
    return { ...composed, sections: result }
  })

  on('prompt.context', async ($, e, next) => {
    const result = await next(e)
    await update($, context, () => [...result.blocks])
    return result
  })

  on('tool.describe', async ($, e, next) => {
    const described = await next(e)
    const { rules } = await load($)
    const r = applyRules(described.description, { where: 'tools', tool: e.tool }, rules, await vars($))
    await record($, r.changed, r.blocked, `tool ${e.tool}`)
    return r.text === described.description ? described : { ...described, description: r.text }
  })

  on('prompt.attachment', async ($, e, next) => {
    const injected = await next(e)
    if (injected.text === null || FILE_ATTACHMENTS.has(e.type)) return injected
    const { rules } = await load($)
    const r = applyRules(injected.text, { where: 'attachments', attachment: e.type }, rules, await vars($))
    const row: Injected = { type: e.type, origin: e.origin?.kind ?? '?', before: injected.text, after: r.text }
    await update($, injectedLog, list => [...(list ?? []), row].slice(-60))
    await record($, r.changed, r.blocked, `attachment ${e.type}`)
    return r.text === injected.text ? injected : { ...injected, text: r.text }
  })

  on('tool.call', async ($, e, next) => {
    const { blocks } = await load($)
    if (!blocks.length) return next(e)
    const args = e as unknown as Record<string, unknown>
    const subject = [args.command, args.file_path, args.notebook_path, args.path].find(
      (x): x is string => typeof x === 'string',
    )
    const text = subject ?? JSON.stringify(args)
    for (const b of blocks) {
      if (b.tools && !b.tools.includes(e.tool)) continue
      if (!b.regex.test(text)) continue
      await record($, [b.id], [], `block ${e.tool}`)
      const message = fill(b.message ?? 'this call matches a block rule.', await vars($))
      return { deny: `alter-system-prompt (${b.id}): ${message}` }
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'alter-prompt' }, async ($, e) => {
    const arg = (e.args ?? '').trim()
    const v = await vars($)
    if (arg === 'reload') {
      cache = null
      const loaded = await load($)
      const errors = loaded.errors.length ? `\nErrors:\n- ${loaded.errors.join('\n- ')}` : ''
      return {
        text: `Reloaded ${loaded.rules.length} rule(s) and ${loaded.blocks.length} block(s) from ${loaded.files.length} file(s). System prompt rules apply from the next message; tool-description changes from a new session or /clear.${errors}`,
      }
    }
    if (arg === 'presets' || arg === 'add') {
      return {
        text: [
          'Presets (add one with /alter-prompt add <name>):',
          ...Object.entries(PRESETS).map(([name, p]) => `- ${name}: ${p.description}`),
        ].join('\n'),
      }
    }
    if (arg.startsWith('add ')) {
      const name = arg.slice(4).trim()
      const preset = PRESETS[name]
      if (!preset) return { text: `No preset named "${name}". Run /alter-prompt presets to list them.` }
      const path = ruleFiles(v)[0]!
      let file: { rules?: { id: string }[]; block?: { id: string }[] } = {}
      if (await $.fs.exists(path)) {
        try {
          file = JSON.parse(await $.fs.read(path))
        } catch {
          return { text: `${path} is not valid JSON, so nothing was added. Fix it, then try again.` }
        }
      }
      const merge = <T extends { id: string }>(have: T[] = [], add: T[] = []) => [
        ...have.filter(x => !add.some(y => y.id === x.id)),
        ...add,
      ]
      file.rules = merge(file.rules, (preset.rules ?? []) as { id: string }[])
      file.block = merge(file.block, (preset.block ?? []) as { id: string }[])
      await $.fs.write(path, `${JSON.stringify(file, null, 2)}\n`)
      cache = null
      const n = (preset.rules?.length ?? 0) + (preset.block?.length ?? 0)
      return {
        text: `Added preset "${name}" (${n} rule${n === 1 ? '' : 's'}) to ${path}. System prompt rules apply from your next message; tool descriptions from a new session or /clear.`,
      }
    }
    if (arg === 'init') {
      const path = ruleFiles(v)[0]!
      if (await $.fs.exists(path)) return { text: `${path} already exists. Edit it, then run /alter-prompt reload.` }
      await $.fs.write(path, STARTER)
      return {
        text: `Created ${path}. Add rules by hand (see the README) or with /alter-prompt add <preset>, then run /alter-prompt reload.`,
      }
    }
    const loaded = await load($)
    const seen = (await read($, hits)) ?? []
    const status = (id: string) => {
      const rows = seen.filter(h => h.id === id)
      if (!rows.length) return 'not matched yet this session'
      return rows.map(h => `${h.kind} ${h.count}x (last: ${h.where})`).join(', ')
    }
    const lines = [
      `Rule files: ${loaded.files.length ? loaded.files.join(', ') : `none yet (/alter-prompt init creates ${ruleFiles(v)[0]})`}`,
      '',
      ...loaded.rules.map(r => `- ${r.id}: ${status(r.id)}${r.description ? ` | ${r.description}` : ''}`),
      ...loaded.blocks.map(b => `- block ${b.id}: ${status(b.id)}`),
    ]
    if (loaded.errors.length) lines.push('', 'Errors:', ...loaded.errors.map(x => `- ${x}`))
    lines.push(
      '',
      'A rule that never matches usually means Claude Code reworded that text: run /prompt-dump and look in system-before.md and attachments.md.',
    )
    return { text: lines.join('\n') }
  })

  on('command.run', { command: 'prompt-dump' }, async $ => {
    const root = await $.session.root()
    const lastOriginal = (await read($, systemBefore)) ?? []
    if (!lastOriginal.length)
      return {
        text: 'Nothing captured yet. Send any message first so Claude Code builds a prompt, then run /prompt-dump again.',
      }
    const lastRewritten = (await read($, systemAfter)) ?? []
    const contextBlocks = (await read($, context)) ?? []
    const attachments = (await read($, injectedLog)) ?? []
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const dir = `${root}/.tmp/prompt-dump-${stamp}`
    const render = (sections: readonly Section[]) =>
      sections.map(s => `<!-- section: ${s.id} | ${s.scope} | ${s.text.length} chars -->\n\n${s.text}`).join('\n\n')
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
