# alter-system-prompt

A Claude Code mod that lets you rewrite the instructions Claude Code gives the model. You write find-and-replace rules in a JSON file, and the mod applies them to the system prompt, tool descriptions, and the messages Claude Code adds during a session. It can also block tool calls that match a pattern.

## Why this exists

Claude Code's built-in instructions aren't editable. `CLAUDE.md`, hooks and `--append-system-prompt` can add instructions, but they can't remove one. When a built-in instruction disagrees with your own rule, the model gets two contradictory instructions, and the built-in one often wins.

The case that started this: Claude Code tells the model to keep temporary files in a per-session "scratchpad" folder under `/private/tmp/claude-<uid>/…`. We keep scratch output in each project's own `.tmp/` folder, where it's gitignored and easy to find. That rule was in `CLAUDE.md` and in saved memory, and Claude still kept saving screenshots and logs to the scratchpad. No Claude Code setting changes it.

A mod can. Claude Code's mod API lets a plugin see that text as it's assembled and change it before it's sent. This mod turns that into a rules file anyone can edit, so you replace the instruction instead of arguing with it.

## Quick start

1. Install:
   ```
   /plugin marketplace add seanperkins/alter-system-prompt
   /plugin install alter-system-prompt@alter-system-prompt
   ```
2. In a new session, run `/alter-prompt presets` to list the ready-made rules, then add one, for example `/alter-prompt add project-tmp`.
3. Send any message, then run `/alter-prompt` to see which rules matched.

To write your own rule, run `/prompt-dump`, find the sentence you want to change, and add a rule for it (format below).

## Commands

| Command | What it does |
|---|---|
| `/alter-prompt` | Lists your rule files and rules, and how often each one matched this session |
| `/alter-prompt presets` | Lists the ready-made rules |
| `/alter-prompt add <preset>` | Copies a preset into your rules file, keeping your other rules |
| `/alter-prompt init` | Creates an empty rules file |
| `/alter-prompt reload` | Re-reads the rule files after you edit them |
| `/prompt-dump` | Saves what the model was last sent to `<project>/.tmp/prompt-dump-<time>/`: the system prompt before and after your rules, the context blocks, and injected messages (rewritten ones are marked) |

## Rule files

Rules are read from two files and merged:

- `~/.claude/alter-system-prompt.json`: your rules, for every project
- `<project>/.claude/alter-system-prompt.json`: rules for one project

When both files have a rule with the same `id`, the project's version wins. If a file has a mistake, the mod shows a notice, skips the broken rule, and keeps the rest.

```json
{
  "rules": [
    {
      "id": "british-english",
      "description": "Answer in British English",
      "addSection": "Write in British English spelling."
    },
    {
      "id": "shorter-tmp-advice",
      "find": "always use it for temporary files",
      "replace": "use {projectRoot}/.tmp for temporary files"
    }
  ],
  "block": [
    {
      "id": "no-force-push",
      "tools": ["Bash"],
      "pattern": "git push .*(--force|-f)\\b",
      "message": "force-pushing is off in this setup."
    }
  ]
}
```

### A rule

Every rule has an `id` and exactly one action.

| Action | What it does |
|---|---|
| `"replace": "…"` | Replaces what `find` or `findRegex` matches. Use `""` to delete. |
| `"append": "…"` / `"prepend": "…"` | Adds text to the end or start of each piece the rule applies to. With `find`, only pieces containing that text. |
| `"addSection": "…"` | Adds a new section at the end of the system prompt. |
| `"dropSection": "<id>"` | Removes a system prompt section by its id. `/prompt-dump` shows the ids. |

Optional fields:

- `find` (literal text) or `findRegex` (a JavaScript regular expression), plus `flags`, for example `"g"` to replace every match or `"m"` so `^` and `$` match at each line.
- `in`: where to look: `"system"`, `"tools"`, `"attachments"`, or a list. Leave it out to look everywhere. Use leaving it out for wording that Claude Code might move around.
- `section`, `tool`, `attachment`: limit the rule to one system prompt section, one tool's description (such as `"Artifact"`), or one kind of injected message (such as `"environment"`). `/prompt-dump` shows the names.
- `enabled: false`: switches a rule off without deleting it.
- `description`: shown by `/alter-prompt`.

In rule text, `{projectRoot}` and `{home}` are filled in, and with `findRegex`, `$1` to `$9` insert the matched groups.

### A block

`block` entries refuse tool calls. `pattern` is a regular expression tested against the call's command (Bash) or file path (Write, Edit, NotebookEdit and others). `tools` limits it to some tools. `message` is shown to the model, with `{projectRoot}` filled in.

## Presets

| Preset | What it does |
|---|---|
| `project-tmp` | Rewrites the session-scratchpad and sandbox `$TMPDIR` instructions to point at `<project>/.tmp/<task>/`, and blocks writes into the scratchpad. |
| `artifact-mockups` | Adds a rule to the Artifact tool: write HTML mockups as local `index.html` + `styles.css` files, and only publish one when asked. |

Presets live in `hooks/presets.ts`. To suggest a new one, add it there with a test.

## What it won't change

Some text is protected, so a rule can't weaken safety or policy instructions by accident:

- **Protected sections** (`action_caution`, `user_privacy`, `heron_brook`, `endconv_deferred_hint`) can be added to but not rewritten or dropped.
- **Protected phrases**, such as the security-testing policy line and "Claude never publishes…" in the Artifact tool, can't be removed from any text. A rule that would remove one is skipped for that text, and `/alter-prompt` reports it as blocked.
- **File contents** shown to the model, such as a file it read or edited, are never rewritten, so the model always sees what's really on disk.

This guards against accidents. It isn't a security boundary.

## Terms of service

The mod only changes text in your own Claude Code sessions, using Claude Code's own mod hooks. It doesn't modify the Claude Code program, take anything apart, or get around a usage limit.

- **Changing the system prompt is supported.** Claude Code has official flags for it: `--system-prompt` replaces the whole prompt and `--append-system-prompt` adds to it ([CLI reference](https://code.claude.com/docs/en/cli-reference)). Output styles and `CLAUDE.md` change it too.
- **Don't use it to remove safeguards.** Anthropic's [Usage Policy](https://www.anthropic.com/legal/aup) forbids bypassing "capabilities, restrictions, or guardrails established within our products". The protections above make that hard to do by accident. Don't write rules that try anyway.
- **The Claude Code program itself is unchanged.** The [legal and compliance page](https://code.claude.com/docs/en/legal-and-compliance) requires Claude Code to run "as published by Anthropic" when a business offers it to others. If you ship this inside a product for other people, check with Anthropic first.
- **One gap:** the hook events this mod uses (`prompt.compose`, `tool.describe`, `prompt.attachment`) come with Claude Code's mod API and its type definitions. They aren't covered in the public hooks documentation yet.

This isn't legal advice. Anthropic's [Consumer Terms](https://www.anthropic.com/legal/consumer-terms) and [Commercial Terms](https://www.anthropic.com/legal/commercial-terms) are the source to check.

## Limits

- **Rules match Claude Code's wording.** If an update rewords a sentence, the rule stops matching and the original goes through unchanged. `/alter-prompt` shows rules that haven't matched, which is the sign to check `/prompt-dump`.
- **When changes take effect.** System prompt and injected-message rules apply from your next message. Claude Code holds on to tool descriptions and context blocks, so changes there apply in a new session or after `/clear`.
- **Blocks only see what the call names.** A block matches the command or path in the call. A program that writes somewhere on its own isn't caught.

## How it's built

Rewrites never depend on anything but your rules. The hooks that change text read the rules (cached), compute the new text with a pure function, and return it. Everything else, the match counts behind `/alter-prompt` and the captures behind `/prompt-dump`, goes into a queue that a single background writer stores. A hook never waits on that writer, so a slow, failing or busy state store can't delay, skip or change a rewrite. The tests check this directly: 50 messages at once while every state write fails, and a state store that never answers.

## Development

```
claude plugin validate .
claude plugin test .
```

To try a change without installing, start a session with `claude --plugin-dir /path/to/alter-system-prompt`.

## License

MIT
