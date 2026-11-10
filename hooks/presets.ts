// Ready-made rules. `/alter-prompt add <name>` copies one into your rules
// file (~/.claude/alter-system-prompt.json); you can also copy them by hand.
// Each preset is a fragment of a rules file: { description, rules?, block? }.

export type Preset = {
  description: string
  rules?: Record<string, unknown>[]
  block?: Record<string, unknown>[]
}

export const PRESETS: Record<string, Preset> = {
  'project-tmp': {
    description:
      "Keep scratch files in the project's .tmp/ folder: rewrites the session-scratchpad and sandbox $TMPDIR instructions, and refuses writes into the scratchpad.",
    rules: [
      {
        "id": "scratchpad-to-project-tmp",
        "description": "Point the built-in scratchpad instruction at the project's .tmp/ folder",
        "findRegex": "^([ \\t]*-[ \\t]*)Scratchpad directory:[^\\n]*$",
        "flags": "m",
        "replace": "$1Temporary files: put scripts, probes, captures, screenshots, logs and any other scratch output in {projectRoot}/.tmp/<unique-task-dir>/ (create it with `mktemp -d {projectRoot}/.tmp/<task>-XXXX` and confirm `.tmp/` is gitignored). Do not use the session scratchpad under /private/tmp or /tmp. When you name one of these files to the user, give its full absolute path."
      },
      {
        "id": "sandbox-tmpdir-to-project-tmp",
        "description": "Point the sandbox's temporary-files line at the project's .tmp/ folder",
        "findRegex": "For temporary files, always use the `\\$TMPDIR` environment variable\\.[^\\n]*",
        "replace": "For temporary files, use {projectRoot}/.tmp/<unique-task-dir>/ (the project folder is writable in the sandbox). Use `$TMPDIR` only for the one command whose tool requires system temp storage, such as a Unix socket path, and say why."
      }
    ],
    block: [
      {
        "id": "no-scratchpad-writes",
        "tools": [
          "Write",
          "Edit",
          "NotebookEdit",
          "Bash"
        ],
        "pattern": "/claude-\\d+/[^/\\s]+/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/scratchpad(?=/|\\s|$|['\"`])",
        "message": "that path is in the session scratchpad. Put scratch files in {projectRoot}/.tmp/<unique-task-dir>/ instead."
      }
    ],
  },
  'artifact-mockups': {
    description: 'Keep HTML mockups as local files: adds a rule to the Artifact tool not to publish mockups unless asked.',
    rules: [
      {
        "id": "artifact-mockups-are-files",
        "description": "Keep HTML mockups as local files instead of published Artifacts",
        "in": "tools",
        "tool": "Artifact",
        "append": "**Mockups are local files (user rule).** When asked for a mockup in HTML, write a local `index.html` plus a separate `styles.css` linked with `<link rel=\"stylesheet\">`, under `docs/mockups/<name>/` or wherever the user says, and give the absolute path. Do not publish a mockup with this tool unless the user explicitly asks for an Artifact; that rule outranks the publish-without-asking guidance above."
      }
    ],
  },
}
