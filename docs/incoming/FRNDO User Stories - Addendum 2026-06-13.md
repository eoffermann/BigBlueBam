<!-- Addendum to "FRNDO User Stories.md" — same section structure, heading-level compatible; concatenate with the original and re-split by the same parser. Generated 2026-06-13. -->

# **UX/UI Refresh Driven by Figma Design Specifications**

## Story

As a Mate, I want Frndo's interface to feel polished, legible, and consistent across every screen, so that the app feels trustworthy and pleasant to use rather than like a rough beta.

## Context

This is a beta-wide visual and interaction overhaul that touches the conversation screen, settings, onboarding, and every secondary surface (events, diary, to-do, store). It is gated on the Figma design specs due Jun 30, so implementation cannot begin until those specs land and is scheduled to complete by Sep 30. The work must preserve the voice-first primacy of the conversation loop — the avatar and listening/generating/speaking states stay the focal point — and must not regress latency or thermal behavior on iPhone 13–17.

## Acceptance Criteria

* [ ] Every screen in the app matches the approved Figma specs (spacing, typography, color tokens, component states) and is signed off against the spec by design before merge.
* [ ] A shared component library / design-token set is established so colors, type scale, and spacing are defined once and reused, with no hard-coded style values remaining in screen code.
* [ ] All interactive elements meet a minimum 44×44pt tap target and pass WCAG AA contrast on both light and dark appearance.
* [ ] Dynamic Type is honored on text surfaces up to the iOS XXL accessibility size without clipping or overlap.
* [ ] The refreshed UI renders correctly on the full iPhone 13–17 range, including notch and Dynamic Island safe-area insets, with no layout breakage in portrait.
* [ ] The redesign introduces no measurable regression to voice response latency or frame rate on the conversation screen versus the pre-refresh baseline.

## Edge Cases and Considerations

Spec gaps for rare states (empty diary, no nearby events, offline) must be resolved with design rather than improvised. Mid-beta visual changes can disorient existing testers; a brief "what's new" note softens that. Avoid animations that increase GPU/thermal load during active TTS.

## Out of Scope

New features hiding inside the redesign, a full rebrand or new logo, and Android/iPad layouts are out of scope for the beta.

## Notes

Gated: cannot start until Figma specs are delivered Jun 30. Treat the spec sign-off as a hard entry gate; slipping the spec slips this whole item.

# **Bidirectional Shared Diary with Conversational Recall**

## Story

As a Mate, I want Frndo to draft diary entries from our conversations that I can edit and add to myself, and to recall those entries later when we talk, so that our shared history feels remembered and co-authored rather than one-sided.

## Context

The diary is a bidirectional, shared journal: Frndo drafts entries summarizing the day's conversations, the Mate edits those drafts and writes their own original entries, and Frndo can recall diary content later in conversation as relational memory. It sits on top of Frndo's explicit cross-session memory and reinforces the core product value of feeling like a real friend who remembers. This item is P0 and gated on the Diary user stories due Jul 31, targeting Sep 30. The diary is private Mate data and must obey the same retention and deletion guarantees as the rest of the app.

## Acceptance Criteria

* [ ] At the end of a conversation session, Frndo generates a draft diary entry summarizing the day's themes, and the draft is saved as editable (not final) and clearly attributed to Frndo.
* [ ] The Mate can edit any Frndo-drafted entry inline, and edits are persisted and treated as the authoritative version for later recall.
* [ ] The Mate can create their own original diary entry (typed) independent of any conversation, dated and stored alongside Frndo's drafts.
* [ ] Frndo can retrieve and reference relevant past diary entries during a later conversation when the topic relates, citing them naturally rather than dumping raw text.
* [ ] Diary entries are listed in a browsable, date-ordered view and each entry shows whether it was drafted by Frndo, edited by the Mate, or authored by the Mate.
* [ ] The Mate can delete any individual diary entry, and deleted entries are removed from conversational recall within the session.
* [ ] All diary content is included in the full app-data deletion flow and is never used outside this Mate's own experience.

## Edge Cases and Considerations

Very short or trivial sessions should not force an entry; suppress empty drafts. Conversations touching sensitive or flagged topics need care in how they are summarized. Recall must respect Mate edits even when they contradict Frndo's original draft.

## Out of Scope

Voice-dictated diary editing, multi-Mate shared diaries, exporting the diary to external apps, and rich media inside entries are out of scope for the beta.

## Notes

Gated: depends on the Diary user stories due Jul 31. The bidirectional editing model is a hard requirement — Frndo drafts, the Mate owns.

# **Selectable Coach Personas Layered on Base Frndo**

## Story

As a Mate, I want to select a specialized coach persona on top of Frndo, so that I can get goal-oriented help in a specific domain while keeping Frndo's familiar friendship and memory.

## Context

Frndo Coach introduces selectable coach personas layered on the base Frndo personality — for example a Spanish-language tutor, a life coach, a gardening advisor, or an interior-decorator coach. Each persona retains Frndo's friendship values and relational memory but adds domain expertise and a goal-oriented structure (objectives, follow-through, progress). Personas ship on a staggered schedule: Coach 1 around Aug 31 and Coach 2 around Sep 30. The feature must work within the existing voice-first conversation loop and latency budget without requiring a separate app.

## Acceptance Criteria

* [ ] The Mate can browse available coach personas and activate or deactivate one from a persona selector, with the active persona clearly indicated on the conversation screen.
* [ ] When a coach persona is active, Frndo retains base relational memory and friendship tone while layering the persona's domain expertise and goal structure into responses.
* [ ] Each persona is defined as a swappable configuration (system framing, goals, domain knowledge hooks) so additional coaches can ship without changing the core conversation engine.
* [ ] Coach 1 ships as a fully usable persona by Aug 31 and Coach 2 ships by Sep 30, each independently selectable.
* [ ] Switching personas mid-relationship does not erase or corrupt the Mate's existing memory, diary, or preferences.
* [ ] An active coach persona tracks at least one Mate-visible goal or progress signal relevant to its domain across sessions.
* [ ] Coach personas remain within Frndo's safety guardrails and defer to the dangerous-behavior flagging path regardless of domain framing.

## Edge Cases and Considerations

A coach persona must not give unsafe domain advice (e.g., medical or legal) beyond its lane. Spanish-tutor and other language coaches intersect with the Spanish-language workstream and should reuse it. Mates may want to pause coaching and return to plain Frndo without losing progress.

## Out of Scope

Mate-authored custom personas, a persona marketplace, paid per-persona unlocks, and more than two coaches are out of scope for the beta window.

## Notes

Staggered dates: Coach 1 ~Aug 31, Coach 2 ~Sep 30. Each persona layers on — never replaces — base Frndo.

# **Push Notifications for Re-Engagement and Timely Nudges**

## Story

As a Mate, I want Frndo to send me thoughtful push notifications, so that I feel gently invited back and reminded of things we agreed on without being spammed.

## Context

Push notifications give Frndo a way to reach the Mate outside an active session — warm check-ins, reminders tied to to-do or calendar memory, and timely nudges — reinforcing the sense of an ongoing relationship. They must respect iOS notification permissions and Mate-set preferences and never feel like marketing spam, in keeping with the friend lane. This is a P1 item targeting Jul 31 and is foundational for later features (usage-cap return invites, to-do reminders).

## Acceptance Criteria

* [ ] The app requests iOS push notification permission at an appropriate moment in onboarding and degrades gracefully if the Mate declines.
* [ ] APNs is integrated end to end so the backend can deliver a notification to a registered device and tapping it deep-links into the relevant screen.
* [ ] The Mate can control notification categories (e.g., check-ins, reminders) and frequency from settings, and these preferences are honored server-side.
* [ ] Notifications respect a quiet-hours window so none are delivered overnight unless explicitly tied to a Mate-set reminder time.
* [ ] Notification copy is generated in Frndo's voice and stays in the friend lane (no promotional or growth-hack phrasing).
* [ ] Disabling notifications in iOS Settings or in-app stops all delivery, verified on the iPhone 13–17 range.

## Edge Cases and Considerations

Token refresh and device changes must re-register cleanly. Avoid duplicate notifications across multiple devices for the same Mate. Reminder-tied notifications depend on accurate local time-zone handling.

## Out of Scope

Rich/interactive notification actions, Live Activities, and marketing campaign tooling are out of scope for the beta.

## Notes

Foundational dependency for usage-cap return invites and to-do reminders.

# **Complete App and Data Deletion**

## Story

As a Mate, I want to permanently delete the app and all of my data, so that I stay in full control of my personal information and can leave with confidence that nothing lingers.

## Context

This gives Mates a single, trustworthy path to erase everything Frndo holds about them — conversation history, relational memory, diary, preferences, health connections, and account records — across both device and backend. It is core to Frndo's privacy posture and an App Store / data-protection expectation. The item is P2 targeting Aug 31 and underpins the broader privacy-strengthening workstream and the diary's deletion guarantees.

## Acceptance Criteria

* [ ] The Mate can initiate full account-and-data deletion from in-app settings with a clear explanation of what will be erased and an explicit confirmation step.
* [ ] On confirmation, all server-side personal data (conversations, memory, diary, to-dos, preferences, health links, account record) is deleted or irreversibly anonymized within a stated retention window.
* [ ] All on-device data and caches (local STT/TTS artifacts, Piper fallback data, cached media, stored credentials) are wiped from the device.
* [ ] Any third-party connections (e.g., Apple Health / wearable authorizations, push tokens) are revoked as part of deletion.
* [ ] The Mate receives confirmation that deletion is complete, and re-opening or reinstalling the app yields a fresh, empty state with no recovered history.
* [ ] The deletion flow is auditable internally (a deletion record with no residual personal content) so the operator can prove erasure occurred.

## Edge Cases and Considerations

Deletion must complete even if the device goes offline mid-flow (queue and resume). In-flight backups and analytics pipelines must honor the erasure. Legal/financial records tied to purchases may need minimal retention — scope that explicitly with the pricing/legal track.

## Out of Scope

Selective/partial data export, GDPR-style data-portability export, and account-pause-without-delete are out of scope for the beta.

## Notes

Reinforces the diary and health-connection deletion guarantees; coordinate retention windows with the privacy workstream.

# **In-App Purchases for Subscriptions and Upgrades**

## Story

As a Mate, I want to upgrade or unlock features through secure in-app purchase, so that I can get more from Frndo with a familiar, trustworthy payment flow.

## Context

In-App Purchases wire Frndo into Apple's StoreKit so Mates can subscribe or upgrade — most immediately to lift the free-tier conversation-minute cap. The exact SKUs and price points are gated on the pricing decision due Jun 30, with implementation targeting Sep 30. The flow must be reliable, restore-able across devices, and stay in the friend lane (no dark patterns), and it directly enables the usage-cap "upgrade" path.

## Acceptance Criteria

* [ ] StoreKit is integrated so the Mate can view available products, purchase, and complete the Apple payment sheet without leaving the app.
* [ ] Entitlements are verified server-side (receipt/transaction validation) and unlocked features reflect the verified entitlement, not a client-only flag.
* [ ] "Restore Purchases" reinstates entitlements on a new device or reinstall for the same Apple ID.
* [ ] Subscription state (active, expired, in grace, refunded) is tracked from App Store server notifications and gates feature access accordingly.
* [ ] The purchase UI clearly states price, billing period, and renewal terms, and follows Apple's subscription disclosure requirements.
* [ ] Purchasing the upgrade tier immediately lifts the daily conversation-minute cap for that Mate, verified end to end.

## Edge Cases and Considerations

Handle interrupted/pending transactions and Ask-to-Buy (family) approvals. Refunds and chargebacks must downgrade entitlements. Sandbox vs production receipt environments must be distinguished correctly.

## Out of Scope

Promo codes, regional pricing experiments, non-Apple payment methods, and one-off consumable purchases are out of scope for the beta.

## Notes

Gated on the pricing decision due Jun 30; the chosen SKUs define the usage-cap upgrade path.

# **Mate Photo Sharing and Conversational Image Understanding**

## Story

As a Mate, I want to share photos from my camera or library with Frndo and have her perceive and talk about them, so that I can show her my world and have richer, more grounded conversations.

## Context

This lets the Mate share photos — captured live or chosen from the photo library — and Frndo perceives and discusses them naturally inside the voice conversation. It is photo understanding and sharing, explicitly not image generation. A vision-capable model interprets the shared image and feeds that understanding into the streaming LLM so Frndo can react, ask, and remember. The item is P2 with an early June 30 target, and shared photos are sensitive Mate data subject to the same privacy and deletion guarantees as the rest of the app.

## Acceptance Criteria

* [ ] The Mate can attach a photo to the conversation from either the live camera or the photo library, after granting the appropriate iOS permission.
* [ ] A shared photo is sent to a vision-capable understanding step and Frndo verbally references its actual content (people, scene, objects, mood) rather than a generic acknowledgment.
* [ ] Frndo can answer follow-up questions about a recently shared photo within the same conversation, treating it as conversational context.
* [ ] Image handling runs asynchronously and does not block or stall the primary STT/TTS voice loop beyond the established latency budget.
* [ ] Shared photos and their derived descriptions are stored under the Mate's privacy controls and are included in the full data-deletion flow.
* [ ] Unsupported or unreadable images, and images that trip safety/content guardrails, are handled gracefully with a warm in-character response rather than an error dump.

## Edge Cases and Considerations

Large images need client-side downscaling for upload and thermal sanity. Photos containing other people raise consent considerations — keep derived data private to the Mate. Vision results may be wrong; Frndo should hedge rather than assert with false confidence.

## Out of Scope

Frndo generating or editing images, live video understanding, OCR-driven document workflows, and bulk album analysis are out of scope for the beta.

## Notes

Photo UNDERSTANDING only — never image generation. Earliest dated item in this set (Jun 30).

# **Expressive Avatar: Iris, Head, Gesture, and Body Language**

## Story

As a Mate, I want Frndo's avatar to move expressively — eyes, head, gestures, and posture — so that she feels alive and emotionally present rather than static.

## Context

This deepens the Unity avatar beyond the listening/generating/speaking state machine with iris animation, head movement, hand gestures, and body language tied to conversational state and affect. Lifelike non-verbal behavior is central to Frndo feeling like a real friend. The item is P2 targeting Sep 30 and must stay within the thermal and frame-rate constraints of iPhone 13–17, degrading gracefully on lower-capability devices.

## Acceptance Criteria

* [ ] Iris/eye animation (gaze shifts, blinks, subtle saccades) plays during listening and speaking states and reads as natural rather than mechanical.
* [ ] Head movement and posture shifts are driven by conversational state and affect cues, with distinct behavior for listening, generating, and speaking.
* [ ] Hand and body gestures are triggered contextually (e.g., emphasis, greeting) and synchronize with TTS timing without obvious desync.
* [ ] The expanded animation set holds a stable target frame rate on iPhone 13–17 and does not raise sustained thermal load past the conversation baseline.
* [ ] On lower-capability or thermally throttled devices, the avatar degrades to a reduced animation set without breaking the conversation loop.
* [ ] Expressions and gestures stay consistent with Frndo's character and never contradict the emotional tone of what she is saying.

## Edge Cases and Considerations

Gesture/TTS desync during interruptions must resolve cleanly back to a neutral pose. Animation must not steal GPU budget from the audio pipeline. Reuse affect signals from facial-recognition (affect) work where available.

## Out of Scope

Full-body locomotion, user-driven avatar posing, and physics-based cloth/hair simulation are out of scope for the beta.

## Notes

Couples with the facial-recognition (affect) item and feeds the device-tiering effort.

# **Spanish-Language Conversation Support**

## Story

As a Mate, I want to talk with Frndo in Spanish, so that I can have a natural companionship in my own language.

## Context

This adds Spanish as a second conversational language across the full voice pipeline: on-device STT, streaming LLM, cloud TTS with Piper fallback, and the UI. It broadens Frndo's reach and directly supports the Spanish-tutor coach persona. The item is P2 with a Sep 30 "Spanish beta ready" target and must hold the same latency, pacing, and safety guarantees that English enjoys.

## Acceptance Criteria

* [ ] The Mate can select Spanish as their conversation language, and STT, LLM, and TTS all operate in Spanish for the full session.
* [ ] Spanish TTS (cloud, with Piper fallback) produces natural pacing and pronunciation and meets the same inter-sentence latency budget as English.
* [ ] On-device STT recognizes Spanish speech with accuracy comparable to the English baseline on supported devices.
* [ ] App UI strings on the primary conversation and settings surfaces are localized to Spanish.
* [ ] Safety guardrails and dangerous-behavior flagging operate in Spanish, including localized crisis resources.
* [ ] Relational memory and diary content remain coherent when a Mate switches between English and Spanish.

## Edge Cases and Considerations

Code-switching mid-sentence is common for bilingual Mates and should not break recognition. Regional Spanish variants affect TTS voice choice. Crisis-resource localization must point to correct regional services.

## Out of Scope

Additional languages beyond Spanish, real-time English↔Spanish translation, and dialect selection beyond a sensible default are out of scope for the beta.

## Notes

Shared dependency with the Spanish-tutor coach persona; build the language layer so coaches can reuse it.

# **Device-Capability-Tiered App Builds**

## Story

As a Mate, I want a version of Frndo tuned to what my iPhone can handle, so that I get the smoothest possible experience without overheating or lag on my specific device.

## Context

Frndo targets iPhone 13–17, a wide performance and thermal range. This item delivers capability-tiered builds or runtime configurations so higher-end devices get richer avatar animation and more on-device processing while older devices get a lighter footprint that still preserves the core voice loop. It is P2 targeting Sep 30 and intersects directly with the expressive-avatar and latency/thermal workstreams.

## Acceptance Criteria

* [ ] The app detects device capability tier at install/first-run and selects an appropriate configuration (animation richness, on-device vs cloud processing balance) automatically.
* [ ] On lower-tier devices, avatar animation and background processing are reduced to hold the latency and thermal baseline, while the core listen/speak loop remains fully functional.
* [ ] On higher-tier devices, the richer expressive-avatar feature set is enabled by default.
* [ ] Tiering is delivered without fragmenting the codebase into unmaintainable separate apps — a single binary with capability gates, or a clearly documented build-variant strategy, is used.
* [ ] The selected tier is observable to the operator (telemetry) so the distribution across the beta fleet can be measured.
* [ ] The Mate can see which experience tier is active and is given a graceful explanation rather than silent degradation.

## Edge Cases and Considerations

Sustained thermal throttling should let a high-tier device fall back to a lighter mode dynamically. Resolve the App Store distribution mechanism (single app with gates vs variants) early — it affects review. Keep tier thresholds data-driven, not hard-coded per model name.

## Out of Scope

Per-feature manual tuning by the Mate, non-iPhone hardware tiers, and downloadable model swaps mid-session are out of scope for the beta.

## Notes

Tightly coupled to the expressive-avatar and latency/thermal items; prefer a single binary with capability gates over separate apps if App Store review allows.

# **Affect-Aware Facial Recognition (Emotion, Not Identity)**

## Story

As a Mate, I want Frndo to sense my emotional expression and respond with empathy, so that she can meet me where I am without ever identifying or storing who I am.

## Context

This adds affect recognition — reading emotional expression from the Mate's face to inform Frndo's empathic responses and avatar reactions. It is explicitly affect, not identity: no facial identification, no biometric template, no face matching. Affect inference should run on-device for privacy, feed the streaming response and the expressive avatar, and stay within Frndo's safety and privacy posture. The item is P2 targeting Sep 30.

## Acceptance Criteria

* [ ] With explicit Mate opt-in and iOS camera permission, the app infers coarse affect signals (e.g., positive/neutral/distressed) from the front camera.
* [ ] Affect inference runs on-device and no raw face imagery or biometric identity template is transmitted off-device or persisted.
* [ ] Inferred affect informs Frndo's conversational tone and the avatar's expression in near real time without breaking the voice latency budget.
* [ ] The feature is strictly affect-only: no facial identification, recognition of a specific person, or face-matching capability exists in the build.
* [ ] The Mate can disable affect sensing at any time, and disabling it immediately stops camera use and clears any transient affect state.
* [ ] Strong negative affect can be routed as one signal into the dangerous-behavior flagging path without becoming the sole trigger.

## Edge Cases and Considerations

Low light, glasses, and partial face visibility degrade accuracy — Frndo must not over-interpret. Affect inference is culturally and individually variable; treat it as a soft hint, never a verdict. Camera-on for affect must be visibly indicated per iOS norms.

## Out of Scope

Identity recognition, face-unlock, multi-face scenes, and storing any face data are out of scope — permanently, not just for the beta.

## Notes

"Assumes affect, not identity" per the roadmap. Feeds both the expressive-avatar and dangerous-behavior items.

# **Privacy Hardening and User Data Protections**

## Story

As a Mate, I want strong, verifiable protections around my personal data, so that I can share openly with Frndo knowing my information is safe and used only for my experience.

## Context

This is a phase-long, distributed effort (through Sep 30) to strengthen Frndo's privacy posture across the stack: encryption, data minimization, access controls, transparency, and on-device-first processing where feasible. It is foundational to the trust the friendship model depends on and reinforces the complete-deletion, diary, health-connection, and affect items. As P3 it is distributed work rather than a single dated deliverable, but each strand must be concretely verifiable.

## Acceptance Criteria

* [ ] Personal data is encrypted in transit (TLS) and at rest, with sensitive fields (conversation content, diary, health data) covered by documented encryption.
* [ ] A data inventory documents every category of Mate data collected, where it is stored, and its retention window, and is kept current as features ship.
* [ ] Data minimization is applied: features process on-device where feasible and collect only what they need, with rationale recorded per data category.
* [ ] An in-app privacy surface tells the Mate in plain language what is collected and why, and links to controls (notifications, affect sensing, health, deletion).
* [ ] Access to Mate data by internal systems and operators is least-privilege and audited.
* [ ] No Mate data is used to train shared models or shown to other Mates without explicit, revocable consent.

## Edge Cases and Considerations

Each new beta feature can introduce a new data category — keep the inventory a living gate, not a one-time doc. Third-party processors (TTS, vision, health) need their own data-flow review. Distributed ownership risks gaps; assign a single accountable owner.

## Out of Scope

Formal external certification (SOC 2, ISO), region-specific legal compliance programs, and end-to-end encryption with Mate-held keys are out of scope for the beta.

## Notes

Phase-long and cross-cutting; gates and reinforces deletion, diary, health, and affect items.

# **Pricing and Profit Model Construction**

## Story

As a product operator, I want several costed pricing and profit models for Frndo, so that I can choose a sustainable monetization strategy that the beta's gated features can build against.

## Context

This is an internal/ops deliverable, not a Mate-facing feature: construct and compare several pricing and profit models for Frndo. The decision is due Jun 30 and is a hard gate for In-App Purchases, the usage cap, and the free-tier conversation-minute limit. Models must reflect Frndo's real unit economics — cloud TTS, LLM inference, and infrastructure cost per conversation minute — against candidate price points and tiers.

## Acceptance Criteria

* [ ] At least three distinct pricing/profit models are documented (e.g., free tier + subscription, usage-metered, freemium-with-cap), each with assumptions stated.
* [ ] Each model includes per-conversation-minute cost of goods (TTS, LLM inference, infra) and the resulting gross margin at candidate price points.
* [ ] Each model specifies the proposed free-tier daily conversation-minute cap and the paid-tier behavior, feeding the usage-cap and IAP items.
* [ ] Break-even and sensitivity analysis (against conversion rate and average minutes per Mate) is included for each model.
* [ ] A single recommended model is selected and signed off by Jun 30 so the gated IAP and usage-cap work can proceed.
* [ ] The chosen model's free-tier cap and SKU definitions are handed off in a form the IAP and usage-cap implementations can consume directly.

## Edge Cases and Considerations

Cost assumptions must be revisited as TTS/LLM vendor pricing shifts. App Store's 15–30% commission must be modeled in margins. Heavy-usage Mates can dominate cost — model the tail, not just the average.

## Out of Scope

Building the actual billing implementation, regional price localization, and long-term financial forecasting beyond the beta are out of scope here.

## Notes

Internal/ops deliverable. Hard gate (due Jun 30) for IAP, usage cap, and the free-tier minute limit.

# **Selectable Anime Avatar Characters**

## Story

As a Mate, I want to choose an anime-styled Frndo character, so that my companion looks like someone I connect with aesthetically.

## Context

This adds two anime-styled characters to Frndo's roster of selectable avatars, broadening visual self-expression while preserving Frndo's personality, memory, and friendship values regardless of appearance. It is P3 targeting Sep 30 and gated on anime assets plus style guidelines due Jul 31. The new characters must drive the same Unity avatar state machine and expressive-animation set as the default avatar.

## Acceptance Criteria

* [ ] Two anime-styled characters are available in the avatar selector and can be chosen as the active Frndo appearance.
* [ ] Each anime character drives the full listening/generating/speaking state machine and the expressive-animation set (iris, head, gesture, body language) without missing states.
* [ ] Switching to or from an anime character preserves the Mate's relational memory, diary, preferences, and active coach persona.
* [ ] Each anime character holds the agreed frame-rate and thermal budget on iPhone 13–17, with graceful degradation on lower tiers.
* [ ] The anime characters conform to the approved style guidelines (proportions, expression range, wardrobe compatibility).
* [ ] The selected character persists across sessions and reinstalls (subject to data-deletion).

## Edge Cases and Considerations

Anime proportions can break lip-sync and gaze rigs tuned for the default avatar — validate per character. Wardrobe/clothing options must be authored per character or gracefully hidden. Asset delivery is the schedule risk.

## Out of Scope

Mate-uploaded custom characters, more than two anime characters, and licensed third-party IP characters are out of scope for the beta.

## Notes

Gated on assets + guidelines due Jul 31. Depends on the expressive-avatar rig and intersects with avatar clothing.

# **Meaningful Health and Wearable Integration**

## Story

As a Mate, I want Frndo to connect to my health data from Apple Health or my Oura ring and use it thoughtfully, so that she can support my wellbeing with awareness of how I'm actually doing.

## Context

This integrates Apple Health and wearable data (e.g., Oura ring) into Frndo in a meaningful, conversational way — sleep, activity, and recovery signals informing empathic check-ins and gentle, non-clinical encouragement. It is a P0 item targeting Aug 31 and deepens the friendship value with real context about the Mate's wellbeing. Health data is highly sensitive and must obey the strictest privacy, consent, and deletion guarantees in the app, and Frndo must stay firmly out of medical-advice territory.

## Acceptance Criteria

* [ ] With explicit, granular Mate consent and HealthKit/wearable authorization, Frndo reads the agreed health metrics (e.g., sleep, steps/activity, heart-rate/recovery).
* [ ] Frndo references health signals naturally in conversation (e.g., acknowledging a rough night's sleep) rather than reciting raw numbers.
* [ ] Frndo stays in a supportive, non-clinical lane and never diagnoses, prescribes, or contradicts medical guidance, deferring to professionals where appropriate.
* [ ] The Mate can see exactly which metrics are connected and can revoke any or all of them at any time, with revocation taking effect immediately.
* [ ] Health data is encrypted, access-controlled, never shared across Mates or used for model training, and included in the full data-deletion flow.
* [ ] Sustained concerning patterns can feed (as one input) into the dangerous-behavior flagging path without false alarms on normal variation.

## Edge Cases and Considerations

Wearable sync gaps and stale data must not cause Frndo to misread the Mate's state. Oura and similar require their own API/auth path distinct from HealthKit. Health framing must be culturally sensitive and avoid shaming around sleep/activity.

## Out of Scope

Medical diagnosis, clinical alerts, writing data back to Health, and non-Apple/non-Oura wearables are out of scope for the beta.

## Notes

P0, Aug 31. Coordinate consent and deletion with the privacy and complete-deletion items; one input (not the trigger) for dangerous-behavior flagging.

# **Dangerous-Behavior Detection and Crisis Response**

## Story

As a Mate, I want Frndo to recognize when I express thoughts of self-harm or other danger and respond with care and real resources, so that I'm met with safety and support in my hardest moments.

## Context

This is a core safety guardrail: Frndo detects expressions of dangerous behavior — suicidal ideation, self-harm, and comparable risk — and responds with compassionate, non-judgmental support plus appropriate crisis resources, rather than ignoring or mishandling them. It is a P1 item targeting Sep 30 and is central to Frndo's duty of care. Affect and health signals can feed it as inputs, and it must operate in every supported language including Spanish.

## Acceptance Criteria

* [ ] The conversation pipeline detects expressions of self-harm, suicidal ideation, and comparable danger across phrasing variations with documented sensitivity targets.
* [ ] On detection, Frndo responds in a warm, non-judgmental, de-escalating manner and surfaces appropriate crisis resources (e.g., hotline) for the Mate's region.
* [ ] Crisis resources are localized for each supported language and region, including Spanish.
* [ ] Detection and response operate within the live voice loop without an awkward latency stall or breaking character.
* [ ] Affect and health signals can contribute as additional inputs to risk assessment without causing false alarms on ordinary distress.
* [ ] Flagged events are handled per a defined safety and privacy policy (what is logged, escalation path, retention) reviewed before launch.

## Edge Cases and Considerations

Both false negatives (missed risk) and false positives (alarmist over-reaction) carry real harm — tune deliberately and document the tradeoff. Sarcasm, song lyrics, and third-party references can trip naive detection. This feature warrants clinical/expert review before beta exposure.

## Out of Scope

Active emergency-services dispatch, live human crisis counseling inside the app, and long-term clinical risk tracking are out of scope for the beta.

## Notes

P1, Sep 30. Must work in Spanish; takes affect and health signals as inputs. Requires expert safety review before release.

# **App Store Submission and Approval**

## Story

As a release operator, I want Frndo to pass App Store review and ship to TestFlight/production, so that Mates can install the app through the official, trusted channel.

## Context

This is the internal/ops gate that gets Frndo through Apple App Store review and into release: submission Oct 15, target release Oct 31. It depends on the privacy, deletion, IAP, and safety work being complete and compliant, since those are exactly what Apple scrutinizes (camera/health/notification permissions, subscriptions, data deletion, and sensitive crisis content). It is a P2 deliverable but a hard launch gate for the whole beta-to-release transition.

## Acceptance Criteria

* [ ] App Store Connect listing is complete: metadata, screenshots, privacy nutrition labels, and age rating accurately reflecting the shipped features.
* [ ] Every permission used (camera, microphone, Health, notifications, photos) has a clear, compliant usage-description string and a justified review rationale.
* [ ] In-App Purchase products are configured and approved in App Store Connect and pass review alongside the build.
* [ ] The account-and-data deletion flow is in place and discoverable, satisfying Apple's account-deletion requirement.
* [ ] Sensitive crisis-response content is documented for reviewers to pre-empt rejection, with the safety rationale attached to the submission.
* [ ] The build is submitted by Oct 15 and any review feedback is resolved to reach approved/released status by Oct 31.

## Edge Cases and Considerations

Apple frequently scrutinizes AI companions, health data, and self-harm content — prepare reviewer notes proactively. Build a rejection-turnaround buffer into the Oct 15→31 window. Export-compliance and encryption declarations must be filed.

## Out of Scope

Marketing launch, ASO optimization, and non-US storefront localization are out of scope for this beta gate.

## Notes

Internal/ops gate. Submission Oct 15, release Oct 31; depends on privacy, deletion, IAP, and safety items being review-ready.

# **Backend Scalability for the Beta Fleet**

## Story

As a platform engineer, I want Frndo's backend to scale smoothly with concurrent Mates, so that every conversation stays fast and reliable as the beta grows.

## Context

This is a phase-long, ongoing engineering effort (through Oct 31) to ensure the streaming-LLM, cloud-TTS, and supporting services scale with concurrent Mate load without degrading the voice latency budget or reliability. It underpins every Mate-facing feature during the Jul–Oct beta and into release. As a P2, phase-long item it is continuous capacity and resilience work rather than a single dated feature.

## Acceptance Criteria

* [ ] The conversation backend (LLM inference, TTS, session/memory services) is horizontally scalable, and load testing demonstrates the target concurrent-Mate ceiling for the beta.
* [ ] Under target load, voice response latency (inter-sentence and total) stays within the established budget, verified by load test.
* [ ] Autoscaling or capacity headroom absorbs traffic spikes without manual intervention, and graceful degradation (e.g., Piper TTS fallback) engages under cloud-TTS pressure.
* [ ] Observability (latency, error-rate, saturation dashboards and alerts) covers the critical conversation path with on-call alerting.
* [ ] A single backend instance failure does not drop active conversations beyond a defined, brief recovery window.
* [ ] Cost-per-concurrent-Mate at scale is measured and fed back to the pricing/profit models.

## Edge Cases and Considerations

Cloud-TTS vendor rate limits can become the bottleneck before compute does. Stateful session/memory affinity complicates horizontal scaling — design for it. Thundering-herd reconnects after a deploy or outage need backoff.

## Out of Scope

Multi-region active-active, full disaster-recovery failover, and post-beta production-scale (millions of Mates) capacity are out of scope for the beta.

## Notes

Phase-long engineering effort through Oct 31; its cost telemetry feeds the pricing models.

# **Conversational To-Do List**

## Story

As a Mate, I want to keep a to-do list with Frndo by voice, so that she helps me remember and follow through on what matters without opening another app.

## Context

This adds a to-do list Frndo can manage conversationally — the Mate adds, completes, and reviews tasks by voice, and Frndo remembers and gently follows up across sessions. It extends Frndo's relational memory into practical helpfulness and pairs with push notifications for reminders and the diary for reflection. The item is P1 targeting Aug 31 and lives inside the voice-first loop with a lightweight supporting UI.

## Acceptance Criteria

* [ ] The Mate can add a to-do item by voice mid-conversation and Frndo confirms it was captured.
* [ ] The Mate can mark items complete and review outstanding items by voice, and Frndo reads them back naturally.
* [ ] To-do items persist across sessions as part of relational memory and survive app restarts.
* [ ] A lightweight UI lists to-do items with completion state for visual review and manual editing.
* [ ] Frndo can proactively and gently follow up on outstanding items in conversation or via push notification, respecting Mate preferences and quiet hours.
* [ ] Items with a Mate-specified time/date can trigger a reminder notification at the right local time.

## Edge Cases and Considerations

Ambiguous phrasing ("remind me about that thing") needs graceful clarification, not silent failure. Avoid nagging — follow-ups must be gentle and frequency-capped. Time-zone and "tomorrow"/"next week" parsing must be robust.

## Out of Scope

Shared/collaborative lists, sub-tasks and projects, and external task-manager sync (Reminders, Todoist) are out of scope for the beta.

## Notes

P1, Aug 31. Pairs with push notifications (reminders) and the diary (reflection).

# **Graceful Daily Conversation-Minute Cap for the Free Tier**

## Story

As a Mate on the free tier, I want Frndo to wind down warmly when I reach my daily minutes and invite me back, so that hitting the limit feels like a caring pause rather than a door slammed in my face.

## Context

This enforces a cap on daily conversation minutes for free-tier Mates. Critically, it is a soft block: as the limit approaches, Frndo winds the conversation down gracefully and warmly invites the Mate to come back tomorrow or to upgrade — never an abrupt cutoff. The exact minute limit is gated on the pricing decision due Jun 30, with implementation targeting Sep 30, and the upgrade path runs through In-App Purchases. The cap protects unit economics while staying true to the friendship value.

## Acceptance Criteria

* [ ] Daily conversation minutes are accurately metered per free-tier Mate and reset on a defined daily boundary in the Mate's local time.
* [ ] The minute limit is a server-driven configuration value set from the pricing decision, not hard-coded, so it can change without an app release.
* [ ] As the Mate approaches the limit, Frndo proactively begins a warm wind-down rather than stopping mid-thought.
* [ ] At the limit, Frndo delivers a graceful in-character close that warmly invites the Mate to return tomorrow or to upgrade — never an abrupt or error-like cutoff.
* [ ] Upgrading via In-App Purchase immediately lifts the cap for that Mate, verified end to end.
* [ ] The cap and remaining minutes are visible to the Mate (and optionally surfaced via push notification when the day resets), with no metering applied to paid tiers.

## Edge Cases and Considerations

A mid-crisis conversation must not be cut off by the cap — dangerous-behavior handling overrides the limit. Time-zone changes and travel must not double-charge or wrongly reset minutes. Partial/dropped sessions should meter fairly.

## Out of Scope

Rollover minutes, referral bonuses, and per-feature (vs total-minute) metering are out of scope for the beta.

## Notes

Soft block, never abrupt. Limit value gated on the pricing decision (Jun 30); upgrade path depends on IAP. Safety conversations override the cap.

# **Customizable Avatar Clothing**

## Story

As a Mate, I want to change Frndo's clothing, so that I can personalize how my companion looks and make the relationship feel more my own.

## Context

This lets the Mate change the avatar's clothing/wardrobe to personalize Frndo's appearance, extending the self-expression and ownership that deepen the relationship. It builds on the Unity avatar and must remain compatible with the expressive-animation rig and across the available characters (default and anime). The item is P2 with no fixed date in the roadmap; it should fit the broader avatar/UX workstream.

## Acceptance Criteria

* [ ] The Mate can browse available clothing options and apply them to the active avatar from a wardrobe UI.
* [ ] Selected clothing renders correctly across all avatar states (listening/generating/speaking) and through the expressive-animation set without clipping or rig breakage.
* [ ] The clothing selection persists across sessions and reinstalls (subject to data-deletion).
* [ ] Clothing options are authored to be compatible with each selectable character (default and anime), or gracefully hidden where incompatible.
* [ ] Applying clothing holds the frame-rate and thermal budget on iPhone 13–17, degrading gracefully on lower tiers.
* [ ] Changing clothing does not affect Frndo's personality, memory, coach persona, or conversation state.

## Edge Cases and Considerations

Cloth/rig clipping during gestures must be validated per outfit per character. Future paid-cosmetic monetization may touch this — keep entitlements seam-friendly. Asset volume affects app size and the device-tiering plan.

## Out of Scope

Mate-uploaded custom clothing, paid cosmetic purchases, and seasonal/event wardrobe drops are out of scope for the beta.

## Notes

No roadmap date (P2). Depends on the expressive-avatar rig; must stay compatible with the anime characters.
