# Frndo Phase 3 — Workstreams

**Purpose.** The schedulable unit of Phase 3 (June 1 → October 31, 2026) is the
set of **top-level tasks in the Bam `Frndo` project** — 44 epics, each holding
exactly one top-level user-story task, with acceptance criteria tracked as
subtasks beneath it. This document is the readable roster of those 44 top-level
tasks (subtasks omitted by design — they'll inherit each top-level task's dates
once we schedule in Bam), cross-referenced to the background briefs in
`docs/background/` that spec each one.

- **Source of truth for status/dates:** the Bam `Frndo` project
  (`/b3` → project **Frndo**, task prefix `FRNDO`). Every row links by its
  `FRNDO-N` id; open that task in Bam for the full story + acceptance criteria.
- **Source of truth for scope/LOE/staffing:** `FRNDO Ph3 Overview.md`,
  `FRNDO Ph3 Schedule.md`, `FRNDO Ph3 Staffing Plan.md` in `docs/background/`.
- **Source material per workstream:** the remaining `docs/background/` briefs,
  abbreviated in the **Brief(s)** column and expanded in the legend below.

Snapshot pulled 2026-06-15 from prod (org `fad29958`). 44 epics · 44 top-level
tasks · 248 acceptance-criteria subtasks. Re-pull to refresh
(`search_tasks` on project `c49a9670-d76a-4efc-80e8-bd1b29f2610b`).

---

## Phase 3 workstream roster (Bam top-level tasks)

Listed in Bam epic order. **Start / End** = scheduled window as `MM/DD` (2026),
read from `FRNDO Ph3 Schedule.md` where the docs support it, else back-filled from a
pre-existing Bam due date, else an invented staggered placeholder (all noted in
Comments). **Dur** = weeks. **Brief(s)** = background spec(s); see legend.
**Comments** = mapping basis, caveats, or date source. Blank date cells = no anchor
of any kind.

| Epic | Task | Title | Start | End | Dur (wk) | Brief(s) | Comments |
| :-- | :-- | :-- | :-- | :-- | :-: | :-- | :-- |
| Reduce Latency | `FRNDO-1` | Reduce Inter-Sentence Latency Perception and Enable Reliable Interruption | 06/17 | 07/15 | 4 | FV, Disamb | Window = existing Bam due − 4 wk (no doc date; Latency Posture is whole-phase) |
| Predictive Cost Analysis | `FRNDO-10` | Predictive Cost Analysis for LLM Inference and Cloud TTS | 06/01 | 10/15 | 19 | SimConv | Ongoing Cost Analysis — whole-phase (end trimmed to 10/15) |
| Voice Capture Accuracy | `FRNDO-18` | Improve Voice Capture Accuracy in Noisy Environments | 07/03 | 07/31 | 4 | Disamb | Window = existing Bam due − 4 wk (no doc line; fed by Mate Voice Disambiguation) |
| Inter-Word Pauses | `FRNDO-24` | Eliminate Unnatural Inter-Word Pauses in TTS Playback | 06/17 | 07/15 | 4 | FV, Piper | Window = existing Bam due − 4 wk (TTS-quality fix; no doc line) |
| TTS Pacing | `FRNDO-29` | Standardize TTS Pacing and Eliminate Unnatural Inter-Sentence Pauses | 06/17 | 07/15 | 4 | FV, Piper | Window = existing Bam due − 4 wk (TTS-quality fix; no doc line) |
| Latency Masking | `FRNDO-35` | Replace Sentiment-Driven Latency Masking with Safe Acknowledgment Fallback | 06/01 | 09/30 | 17 | FV, Affect | Mapped to On-Device Text Affect Inference (sentiment work); *optional* workstream — may defer to Phase 4 |
| Relational Memory | `FRNDO-41` | Store and Surface Explicit Relational Memories Across Sessions | 06/01 | 08/31 | 13 | — | Spans base memory API (Jun–Jul) + Precise Relationship Memory (Aug); narrows to Aug if just the extractor |
| Thermal Telemetry | `FRNDO-47` | Implement Thermal-Aware Telemetry and Baseline Degradation to Reduce App Heating | 07/01 | 08/31 | 9 | DevSup | Device Compatibility telemetry lines; "thermal" not named specifically |
| UX/UI Refresh | `FRNDO-54` | UX/UI Refresh Driven by Figma Design Specifications | 06/01 | 09/30 | 17 | — *(cond.)* | Conditional — assumes Figma / user stories by 06/30 |
| QA Testing | `FRNDO-61` | Structured Daily QA Testing and Fix Verification via TestFlight | 06/01 | 10/15 | 19 | — | Structured Tester Program — whole-phase (end trimmed to 10/15) |
| On-Device TTS | `FRNDO-68` | Implement On-Device Text-to-Speech with Curated Device Support and Privacy Controls | 06/01 | 09/30 | 17 | FV, Piper, S2V, DevSup | — |
| News Hook | `FRNDO-74` | Daily Interest-Matched News Hook in Conversation | 06/01 | 09/30 | 17 | — *(cond.)* | Conditional — backend ships regardless; polish assumes user stories by 07/31 |
| Mate Interruptions | `FRNDO-80` | Capture Mate Interruptions During TTS Chunk Pauses | 06/17 | 07/15 | 4 | Disamb | Invented 4-wk span overlapping the latency/voice cluster (fed by Mate Voice Disambiguation) |
| Conversational Values | `FRNDO-85` | Align Conversational Behavior with Core Friendship Values and Safety Guardrails | 06/01 | 10/15 | 19 | Rabbi | Worldview Alignment (incl. red-team rounds); end trimmed to 10/15 |
| Deep Listening | `FRNDO-92` | Ground Conversations in Deep Listening, Context, and Honest Reframing | 06/17 | 07/15 | 4 | Rabbi, Tempo | Invented 4-wk span overlapping latency/voice/values (folds into Values/Capability) |
| Calendar Memory | `FRNDO-98` | Conversational Calendar Memory and Soft Event Nudges | 06/01 | 09/30 | 17 | — *(cond.)* | Conditional — assumes user stories + Figma by 06/30 |
| Product Discovery | `FRNDO-104` | Voice-Driven Product Discovery and Retailer App Routing | 06/15 | 07/15 | 4 | TxnSvc, Rye | Invented staggered slot in the Transactional window (1st of 4); revise when category→provider lands |
| Food Discovery | `FRNDO-110` | Voice-Driven Food Discovery, Delivery Routing, and Directions | 07/15 | 08/15 | 4 | TxnSvc | Invented staggered slot in the Transactional window (2nd of 4); revise when category→provider lands |
| Event Discovery | `FRNDO-116` | Voice-Driven Local Event Discovery and Routing | 08/15 | 09/15 | 4 | TxnSvc | Invented staggered slot in the Transactional window (3rd of 4); revise when category→provider lands |
| Shared Diary | `FRNDO-122` | Bidirectional Shared Diary with Conversational Recall | 07/01 | 09/30 | 13 | — *(cond.)* | Diary backend committed; UX above default conditional on user stories by 07/31 |
| Travel Search | `FRNDO-130` | Voice-Driven Flight Search and Provider App Routing | 09/01 | 09/30 | 4 | TxnSvc | Invented staggered slot in the Transactional window (4th / stretch); revise when category→provider lands |
| Frndo Coach | `FRNDO-136` | Selectable Coach Personas Layered on Base Frndo | 06/01 | 09/30 | 17 | Coach, Rabbi | Coach 1 committed; Coach 2 only targeted (Aug–Sep) |
| Capability Awareness | `FRNDO-144` | Improve Conversational Awareness of Capabilities and Permission Boundaries | 06/01 | 09/30 | 17 | Rabbi, Tempo | — |
| Push Notifications | `FRNDO-152` | Push Notifications for Re-Engagement and Timely Nudges | 07/03 | 07/31 | 4 | — | Window = existing Bam due − 4 wk (not a named workstream in docs) |
| Device Performance | `FRNDO-159` | Graceful Performance Degradation Across iPhone 13–17 Devices | 07/01 | 09/30 | 13 | DevSup | — |
| Account Deletion | `FRNDO-165` | Complete App and Data Deletion | 07/01 | 08/31 | 9 | — | Full Account and Data Wipe |
| In-App Purchases | `FRNDO-172` | In-App Purchases for Subscriptions and Upgrades | 07/01 | 09/30 | 13 | SimConv, Market | Maps to Pricing Model → App Store IAP coordination |
| Photo Sharing | `FRNDO-179` | Mate Photo Sharing and Conversational Image Understanding | 06/02 | 06/30 | 4 | — | Window = existing Bam due − 4 wk (not a named workstream in docs) |
| Expressive Avatar | `FRNDO-186` | Expressive Avatar: Iris, Head, Gesture, and Body Language | 06/01 | 09/30 | 17 | Anim | Animation Expansion (outreach Jun → Unity integration / QA Sep) |
| Spanish Support | `FRNDO-193` | Spanish-Language Conversation Support | 06/01 | 09/30 | 17 | — | Internationalization |
| Device-Tiered Builds | `FRNDO-200` | Device-Capability-Tiered App Builds | 07/01 | 09/30 | 13 | DevSup | Maps to Device Compatibility toggle work; Bam title ≠ the doc's single-binary approach |
| Facial Recognition | `FRNDO-207` | Affect-Aware Facial Recognition (Emotion, Not Identity) | 06/01 | 09/30 | 17 | Affect | On-Device Visual Affect Inference — *optional* workstream; may defer to Phase 4 |
| Privacy Hardening | `FRNDO-214` | Privacy Hardening and User Data Protections | 08/05 | 09/30 | 8 | — | Invented 8-wk Aug–Sep run (no doc line; privacy/consent otherwise embedded in other streams) |
| Pricing Models | `FRNDO-221` | Pricing and Profit Model Construction | 06/01 | 09/30 | 17 | SimConv, Market | Pricing Model Decision; model *selection* owed by Moe/Mike by 06/30 |
| Anime Characters | `FRNDO-228` | Selectable Anime Avatar Characters | 06/01 | 09/30 | 17 | — *(cond.)* | Conditional — gated on IP assets by 07/31 |
| Health Integration | `FRNDO-235` | Meaningful Health and Wearable Integration | 06/01 | 08/31 | 13 | — | HealthKit expansion — *optional* workstream; scope may land incrementally |
| Crisis Response | `FRNDO-242` | Dangerous-Behavior Detection and Crisis Response | 07/01 | 09/30 | 13 | — | Crisis Handling Expansion |
| App Store Approval | `FRNDO-249` | App Store Submission and Approval | 06/01 | 10/15 | 19 | — | Apple Org Migration (Jun–Aug) + Oct submission / release; end trimmed to 10/15 |
| Scalability | `FRNDO-256` | Backend Scalability for the Beta Fleet | 06/01 | 10/15 | 19 | — | Only "Performance Testing API Layers" (whole-phase, light) — loose fit; end trimmed to 10/15 |
| Sentiment Analysis | `FRNDO-263` | Implement Near-Realtime Local Sentiment Analysis for Latency Masking and Affective Prosody | 06/01 | 09/30 | 17 | Affect, FV | On-Device Text Affect Inference — *optional* workstream; may defer to Phase 4 |
| Patent Filing | `FRNDO-269` | Document and Draft Provisional Patent Applications for Core Innovations | 06/01 | 10/15 | 19 | — | Patent Filings — whole-phase (end trimmed to 10/15) |
| To-Do List | `FRNDO-275` | Conversational To-Do List | 08/03 | 08/31 | 4 | — | Window = existing Bam due − 4 wk (not a named workstream in docs) |
| Usage Cap | `FRNDO-282` | Graceful Daily Conversation-Minute Cap for the Free Tier | 07/01 | 09/30 | 13 | SimConv | Maps to Pricing Model tier-gating / entitlement (free-tier cap), not its own line |
| Avatar Clothing | `FRNDO-289` | Customizable Avatar Clothing | — | — | — | Wardrobe | Newly in-scope; no schedule line exists for it yet |

---

## Source-brief legend

Abbreviations used in the **Brief(s)** column, with how authoritative each brief is
for the task it feeds. Full classification rationale was the prior revision of this
doc; condensed here.

| Abbrev | Background brief | Use as |
| :-- | :-- | :-- |
| FV | `FRNDO - FrndoVoice.md` | Primary — Chatterbox latency/reliability foundation |
| Piper | `Frndo - Training New Voices for PiperTTS.md` | Reference — Piper voice-training pipeline |
| S2V | `FRNDO SpeechToVoice Model Option.md` | Decision input — Qwen3-Omni eval (not committed) |
| Affect | `FRNDO Affect Inference.md` | Supporting — on-device emotion model selection/deploy |
| Disamb | `FRNDO Mate Voice Disambiguation.md` | Primary — speech-isolation architecture |
| Tempo | `FRNDO Conversational Tempo in Dyadic Exchanges.md` | Supporting — response-timing UX |
| SimConv | `FRNDO Simulated Conversations.md` | Primary — conversation cost/length model |
| TxnSvc | `FRNDO Transactional Services.md` | Primary — commerce provider/API survey |
| Rye | `FRNDO Rye Universal Checkout.md` | Reference — universal checkout (named *later* option) |
| DevSup | `FRNDO Device Support.md` | Primary — Tier A/B/C device matrix |
| Coach | `FRNDO Coach Archetypes.md` | Primary — coach persona candidates |
| Rabbi | `FRNDO LLMRabbi Overview.md` | Primary — "reason from sources" training method |
| Anim | `Frndo - Animation Guidance.md` | Primary — mocap mood-state brief |
| Wardrobe | `FRNDO Modular Avatar Wardrobe System.md` | Primary — modular wardrobe architecture (in scope) |
| Market | `FRNDO AI Companion App Landscape_…Market Research Synthesis.md` | Context only — GTM/pricing background |

Rows with **—** have no dedicated background brief; plan them from the three
`Ph3` docs (and from Bam's own story + acceptance criteria). *(cond.)* marks the
conditional workstreams gated on outside-engineering inputs (Figma/user stories/IP
assets) per the Overview's deadlines.

The **three `Ph3` planning docs** (`Overview`, `Schedule`, `Staffing Plan`) sit
above this whole table — they define the LOE, role, and date envelope every row is
scheduled into.

---

## Scheduling status

We're scheduling these 44 top-level tasks **as written** in Bam; subtasks inherit
their parent's dates. Current state:

- **20 of 44 dated**, **24 undated** — putting dates on the rest is the immediate
  next step.
- Dates land inside the `Ph3 Schedule` month-blocks: kickoff Jun 1, **feature lock
  Sep 30** (anything not feature-complete reallocates to Phase 4), App Store release
  Oct 31; October is reserved for stabilization, red-team, and bug-fix only.
- **Conditional rows** (marked *(cond.)* — UX/UI Refresh, News Hook, Calendar
  Memory, Shared Diary, Anime Characters) can't take firm implementation dates until
  their outside-engineering inputs (Figma / user stories / IP assets) arrive on the
  Overview's deadlines. Schedule the spec-support window now; date the
  implementation window against the input.

One technical decision is still open and worth noting when dating `FRNDO-68
On-Device TTS`: whether Phase 3 pivots to Qwen3-Omni (`S2V` brief) or stays on the
Chatterbox/Piper path. It changes the work *inside* that task, not its slot in the
schedule.

---

*Compiled 2026-06-15. Roster mirrors the Bam `Frndo` project top-level tasks at
that timestamp; Bam remains authoritative for status and dates. Re-pull and
re-generate the table when epics/tasks change.*
