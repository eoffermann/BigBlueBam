# Brainstorming sessions

Output home for the `suite-brainstorm` skill. Each run writes two dated files here:

- `YYYY_MM_DD_HH_MM_BRAINSTORMING_SESSION.md` - the full session log: five ideator
  seats proposing five apps each, the debate, submissions, overlap/merge
  negotiations, and the vote rounds that pick one winner.
- `YYYY_MM_DD_HH_MM_APP_DESIGN_<appname>.md` - the winning app's design spec,
  drafted by `brainstorm-spec-writer` and hardened over adversarial review rounds
  (design, security, stability, best-practices, infrastructure).

Run it by invoking the `suite-brainstorm` skill. The skill (`.claude/skills/
suite-brainstorm/SKILL.md`) is the orchestrator playbook; it drives the
`brainstorm-ideator`, `brainstorm-spec-writer`, and `brainstorm-spec-adversary`
agents in `.claude/agents/`.

These documents are ideation artifacts. Nothing here has been scheduled or
approved for build; a design spec landing here is the input to a later, separate
implementation decision.
