# alter-system-prompt

A Claude Code mod that rewrites parts of Claude Code's built-in instructions when they clash with your own rules.

## Why this exists

Claude Code sends the model a system prompt you can't edit. Your own instructions (`CLAUDE.md`, memory, hooks) are added alongside it, but they can't remove anything. When a built-in line and your rule disagree, the model gets two instructions that contradict each other, and the built-in one often wins.

The case that started this: Claude Code tells the model to keep temporary files in a per-session "scratchpad" folder, for example:

```
/private/tmp/claude-501/<project>/<session-id>/scratchpad
```

We keep scratch output in the project's own `.tmp/<task>/` folder instead. It's gitignored, it sits next to the code it belongs to, and you can find it later. That rule was in `CLAUDE.md` and in saved memory, and Claude still kept saving screenshots and logs to the scratchpad, then pointing us at files buried in `/private/tmp`.

There's no setting for this. Claude Code has no option to turn the scratchpad off or point it at a project folder. `CLAUDE_CODE_TMPDIR` moves the whole temp directory to one path for the machine, not per project. Hooks, `CLAUDE.md` and `--append-system-prompt` can only add text, not take the built-in line away.

A mod can. Claude Code's mod API lets a plugin see the system prompt as it's built and change it before it's sent, so this mod replaces the instruction instead of arguing with it.

## What it does

1. **Rewrites the scratchpad instruction.** The line telling the model to use the session scratchpad becomes "put scratch files in `<project>/.tmp/<unique-task-dir>/`". The sandbox's "use `$TMPDIR` for temporary files" line gets the same change. The rewrite covers the system prompt, tool descriptions and the notices Claude Code injects partway through a session.
2. **Blocks writes into the scratchpad.** A `Write`, `Edit`, `NotebookEdit` or `Bash` call that touches the session scratchpad is refused, with a message pointing to the project's `.tmp/`. A slip fails immediately instead of producing files nobody can find.
3. **Adds `/prompt-dump`.** It saves what the model was last sent to `<project>/.tmp/prompt-dump-<time>/`:
   - `system-before.md`: the system prompt as Claude Code built it
   - `system-after.md`: the same prompt after this mod's changes
   - `context.md`: the context blocks, such as `CLAUDE.md` and the date
   - `attachments.md`: messages Claude Code injected, with rewritten ones marked
   - `sections.tsv`: every piece with its size

   Use it to check the rewrite worked, and to find the next built-in instruction worth changing.

## Install

```
/plugin marketplace add MobilityLabs/alter-system-prompt
/plugin install alter-system-prompt@alter-system-prompt
```

Restart Claude Code, or start a new session, so the rewritten prompt is used from the first message. The write block takes effect as soon as the mod loads.

Make sure `.tmp/` is gitignored in your projects, or globally with `echo '.tmp/' >> ~/.config/git/ignore`.

## Limits

- **It matches Claude Code's wording.** The rewrites look for specific sentences. If a Claude Code update rewords them, the rewrite stops matching and the original text goes through unchanged. The write block keeps working, and `/prompt-dump` shows whether the rewrite still lands.
- **Only commands that name the scratchpad are blocked.** The `Bash` block catches commands that contain the scratchpad path. A program that writes to `$TMPDIR` on its own isn't affected.
- **The sandbox temp folder itself doesn't change.** Sandboxed commands still get a system `$TMPDIR`. Some tools need it, for example for Unix sockets, which have a short path limit.

## Adding a rewrite

Rewrites are a list of `{ find, replace }` pairs in `hooks/register.ts`. Run `/prompt-dump`, find the sentence you want changed in `system-before.md` or `attachments.md`, and add a pattern for it. Keep each pattern narrow so it only matches the sentence you mean.

## Development

```
claude plugin validate .
claude plugin test .
```

To try a change without installing, start a session with `claude --plugin-dir /path/to/alter-system-prompt`.

## License

MIT
