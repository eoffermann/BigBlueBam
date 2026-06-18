/**
 * Gilligan's Island themed Beacon (knowledge base) seed.
 *
 * The castaways keep an "island survival wiki" — the Professor's how-tos,
 * Mary Ann's recipes, the Skipper's seamanship, and the Howells' notion of
 * etiquette. Idempotent by slug via the beacon-api /v1/entries/upsert
 * endpoint; publishing + tagging are also re-run-safe (already-Active
 * publish and duplicate tag adds are tolerated).
 *
 * Run from the repo host:
 *   GKEYS=$(node -e '<load scripts/.gilligan-keys.env to JSON>') \
 *   docker compose exec -T -e GKEYS="$GKEYS" api node - < scripts/seed-gilligan/beacon.mjs
 *
 * The api container shares the backend docker network with beacon-api, so it
 * reaches it at the internal host below. The cast API keys authenticate via
 * Bearer (bypasses CSRF) and scope every write to the Gilligan org.
 */

// beacon-api internal host. The /v1 prefix is part of the base: every route
// (beacons, entries/upsert, beacons/:id/publish, beacons/:id/tags) is
// registered under /v1 in apps/beacon-api/src/server.ts.
const BEACON = 'http://beacon-api:4004/v1';
const KEYS = JSON.parse(process.env.GKEYS || '{}');

// Only set Content-Type when a body is present. Fastify rejects a request
// with Content-Type: application/json and an empty body
// (FST_ERR_CTP_EMPTY_JSON_BODY), which is exactly the shape of a bodyless
// POST /beacons/:id/publish.
function H(who, hasBody) {
  const h = { Authorization: `Bearer ${KEYS[who]}` };
  if (hasBody) h['Content-Type'] = 'application/json';
  return h;
}

async function beacon(who, method, path, body) {
  const r = await fetch(`${BEACON}${path}`, {
    method,
    headers: H(who, body !== undefined),
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await r.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }
  if (!r.ok) {
    throw new Error(`${method} ${path} -> ${r.status} ${JSON.stringify(data).slice(0, 250)}`);
  }
  return { status: r.status, data };
}

// Knowledge articles. `author` is the cast key that owns + publishes the
// article; `status: 'Draft'` keeps an article unpublished (the others all go
// Active). Bodies are real Markdown — funny, in-character.
const ARTICLES = [
  {
    slug: 'two-way-radio-from-coconuts',
    title: 'Building a Two-Way Radio from Coconuts',
    author: 'professor',
    summary: 'A practical guide to assembling a working transceiver from coconut husks, salvaged Minnow wiring, and sheer optimism.',
    tags: ['survival', 'rescue', 'electronics'],
    body: `# Building a Two-Way Radio from Coconuts

It is a recurring source of mild scientific frustration that I can construct a
functioning superheterodyne receiver from two coconuts, a length of copper wire,
and the foil from a stick of the Howells' chewing gum, yet I cannot seem to
patch a four-foot hole in a wooden boat.

## What you will need

- **2 mature coconuts** (one for the resonant cavity, one because Gilligan will
  drink the first).
- **Copper wire** salvaged from the Minnow's wiring harness.
- **A galena crystal**, or failing that, a sufficiently confident rock.
- **The bicycle generator** (see *Charging the Battery*). Gilligan pedals.

## Assembly

1. Hollow the first coconut and line the cavity with foil to form the tuned
   circuit. Do **not** eat the foil.
2. Wind 40 turns of copper wire around the husk for the inductor. Count them
   twice; the Skipper will recount them a third time and be wrong.
3. Connect the crystal detector. Tap it gently. If you hear Honolulu, you have
   succeeded. If you hear Gilligan, the antenna lead has come loose again.

## Operating notes

Keep transmissions under thirty seconds — the battery is only as patient as the
man on the bicycle. And whatever you do, do **not** let Gilligan near the tuning
dial. We were *four kilohertz* from the Coast Guard last Tuesday.

> **Professor's note:** Yes, I know. If I can do all this, why are we still
> here? Please direct that question to whoever keeps sitting on the radio.`,
  },
  {
    slug: 'lagoon-fishing-and-spear-technique',
    title: 'Lagoon Fishing & Spear Technique',
    author: 'skipper',
    summary: 'How to feed seven people from the lagoon without losing your spear, your footing, or your dignity.',
    tags: ['survival', 'food', 'sea'],
    body: `# Lagoon Fishing & Spear Technique

Forty years at sea taught me three things: respect the tide, trust your crew,
and never hand Gilligan anything with a point on it. We'll cover the first two.

## Reading the lagoon

The fish run thick over the reef at first light and again at dusk. Stand still.
The water bends the light, so the fish is **never** where it looks like it is —
aim a hand's width below and in front. If you spear your own foot, you aimed at
where it looked like it was. Little buddy, I'm looking at you.

## The spear

A straight length of bamboo, fire-hardened at the tip and split into four barbed
prongs. Lash the prongs apart with vine so they spread on impact.

1. Wade in slow. Do not splash. Fish can hear a clumsy first mate from the
   *other side of the island*.
2. Hold the spear low and ready, not over your head like a movie pirate.
3. Strike down and forward in one motion. Pin the fish to the sand, then reach.

## What to bring back

Bring it straight to Mary Ann. She'll turn a parrotfish and three sea urchins
into something that makes you forget you're shipwrecked. Bring it to Gilligan and
he'll name it and ask to keep it as a pet.`,
  },
  {
    slug: 'reading-the-stars-to-navigate-home',
    title: 'Reading the Stars to Navigate Home',
    author: 'professor',
    summary: 'Celestial navigation for the stranded: finding south, fixing latitude, and why none of it has worked yet.',
    tags: ['navigation', 'rescue', 'survival'],
    body: `# Reading the Stars to Navigate Home

Navigation by the stars is among humanity's oldest sciences, and on a clear
South Pacific night the sky is a chart more accurate than anything in my pocket.
The trouble has never been the stars. The trouble has been the steering.

## Finding south

We are in the southern hemisphere, so forget Polaris. Locate the **Southern
Cross**, extend the long axis four and a half times its length, and drop
straight down to the horizon. That point is due south. From there, our heading
home is roughly north-northeast.

## Fixing latitude

Measure the angle of a known star above the horizon at its zenith using a
bamboo cross-staff. I have built three. The Skipper has stepped on two.

## Putting it to use

With a heading and a calm sea, a man with a paddle and a sense of purpose can
make real progress before dawn. We have proven this repeatedly. We have also
proven, repeatedly, that the same man can paddle enthusiastically in a complete
circle and return to the very beach he launched from, convinced he has
discovered a *new* island.

> **Filed under:** things that should work, and would, if the raft didn't keep
> springing a leak. See also: *Bamboo Raft Construction 101*.`,
  },
  {
    slug: 'mary-anns-coconut-cream-pie',
    title: "Mary Ann's Coconut Cream Pie",
    author: 'maryann',
    summary: 'The pie that almost got us rescued (a passing pilot smelled it). Back home in Kansas we called this Sunday-best.',
    tags: ['recipes', 'food'],
    body: `# Mary Ann's Coconut Cream Pie

Back home in Kansas, my Aunt Martha said you could measure a person by their pie
crust. Well, out here all I've got is coconut, coconut, and more coconut — so I
learned to measure folks by what they're willing to do with it. The Professor
helped me work out the chemistry; Gilligan helped me work out how *not* to leave
a pie unattended.

## The crust

Toast shredded coconut over the cook-fire until golden, press it into a shell
made from the bottom half of a — you guessed it — coconut. No flour, no fuss.

## The filling

- **3 cups coconut milk**, hand-pressed (this is Gilligan's job; it builds
  character).
- **Egg** if the wild hens are cooperating, otherwise we improvise.
- **A pinch of the Howells' sugar**, rationed like it's gold. According to
  Mrs. Howell, it practically *is*.

Cook it low and slow until it coats the back of a spoon. Fold in fresh coconut.
Chill it in the spring-fed pool.

## Serving

Seven slices. **Seven.** I count them, and then I count Gilligan, and then I
count the slices again. The day a Navy pilot circled low because he smelled this
pie cooling, I knew I'd done my Aunt Martha proud — even if he didn't land.`,
  },
  {
    slug: 'bamboo-raft-construction-101',
    title: 'Bamboo Raft Construction 101',
    author: 'skipper',
    summary: 'Build a seaworthy raft from bamboo and vine. Sea trials mandatory. Gilligan does not steer.',
    tags: ['survival', 'sea', 'rescue'],
    body: `# Bamboo Raft Construction 101

I've captained vessels from harbor tugs to the S.S. Minnow, and I'll tell you,
the raft is the purest form of seamanship there is. No engine to fail you. Just
you, the bamboo, and the question of whether your knots will hold.

## Selecting bamboo

Cut forty lengths, each as thick as your wrist, and **cure them in the sun for a
week**. Green bamboo is heavy and waterlogs. The Professor will insist on a
tensile test. Let him. He's usually right, which is its own kind of annoying.

## Lashing

Square lashings at every crossing, doubled at the corners. Use the strongest
vine rope you can twist. A raft is only as good as its weakest knot, and we have
lost two perfectly good rafts to one bad one.

## Sea trials

1. Launch at high tide in the lagoon.
2. Load it gradually. Watch the waterline.
3. **Do not let Gilligan steer.** This is not a personality conflict. This is
   forty years of hard-won maritime wisdom. The last time he steered, we ended
   up *farther* from civilization than the island.

If the raft floats, holds seven, and points the right way, you've done your job.
Getting it to *stay* pointed the right way — that's a conversation for the
Professor's star charts.`,
  },
  {
    slug: 'when-a-ship-is-sighted',
    title: 'What To Do When a Ship Is Sighted',
    author: 'skipper',
    summary: 'The drill for the moment we have all been waiting for. Read it now; there will be no time to read it then.',
    tags: ['rescue', 'survival'],
    body: `# What To Do When a Ship Is Sighted

This is the most important page in the whole wiki, so pin it up where everyone
can see it. When a ship appears on the horizon there is **no time to figure out
the plan** — there is only time to execute it. We have lost more chances to
confusion than to bad luck.

## The drill

1. **Sound the alarm.** Three blasts on the conch. Everyone drops what they're
   doing. Yes, Ginger, *everyone*.
2. **Light the signal fire** on Lookout Point. The dry tinder is stacked and
   covered. Keep it dry. (See: *Surviving the Wet Season*.)
3. **Mirror flashes** at the bridge. Three flashes, pause, three flashes.
4. **Everyone to the beach** waving anything bright. The Howells' wardrobe is,
   for once, genuinely useful.

## What NOT to do

- Do **not** let Gilligan run for the signal fire. The last three ships sailed
  on after he tripped, knocked over the woodpile, and put the fire **out**.
- Do **not** stop to pack. We are not bringing the furniture.
- Do **not** assume "they must have seen us." They never just see us.

Read this now. Memorize it. When the day comes, we move as one crew — and this
time, that ship is going to stop.`,
  },
  {
    slug: 'surviving-the-wet-season',
    title: 'Surviving the Wet Season',
    author: 'professor',
    summary: 'Storm-proofing the huts, keeping the fire and the radio dry, and rationing morale through the monsoon.',
    tags: ['survival', 'food'],
    body: `# Surviving the Wet Season

When the monsoon arrives it does not knock. The barometric drop is detectable a
full day ahead — I have rigged a crude aneroid barometer from a sealed bamboo
chamber — but the rest is preparation, discipline, and a great deal of patience
with one another.

## Storm-proofing the huts

Re-thatch every roof with a double layer of palm, pitched steep so water runs
off. Dig a drainage trench uphill of each hut. Stake everything down: in a real
blow, a poorly secured hut becomes a sail, and we have watched the Howells' veranda
take flight more than once.

## Protecting what matters

- **The fire.** Move embers into the dry cave and feed them sparingly. A fire is
  far easier to keep than to restart in a downpour.
- **The radio.** Wrap it in oilcloth and store it high. Saltwater is the enemy
  of every circuit I've built.
- **The food stores.** Mary Ann rotates the dry goods and rations the sugar. Wet
  coconut spoils faster than you'd think.

## Morale

The rains last weeks, and seven people in close quarters is its own survival
challenge. Schedule activities. Mr. Howell runs a surprisingly cutthroat bridge
tournament. Ginger does dramatic readings. Gilligan does Gilligan, which —
remarkably — helps.`,
  },
  {
    slug: 'howell-guide-to-island-etiquette',
    title: 'The Howell Guide to Island Etiquette',
    author: 'howell',
    summary: 'Maintaining standards in reduced circumstances. One simply does not let a little shipwreck become an excuse.',
    tags: ['etiquette', 'survival'],
    body: `# The Howell Guide to Island Etiquette

My dear castaways, civilization is not a *place* — it is a *posture*. A Howell
does not abandon standards merely because one's yacht club is several thousand
miles away and one's butler is, regrettably, not. Herewith, a few firm but
loving guidelines.

## Dressing for dinner

One dresses for dinner. I appreciate that the wardrobe is somewhat limited to
what survived the Minnow, but Lovey and I manage admirably, and so may you. A
coconut-shell ascot is perfectly acceptable in a pinch.

## Forms of address

The Professor shall be addressed as "Professor." The Captain as "Skipper." The
young man — Gilligan, is it? — may continue to be addressed loudly, and often.

## Dining

- Place cards, even on bamboo, are not optional.
- One does not begin until Lovey lifts her coconut.
- Pie is divided **equally**. (Mary Ann is very firm on this and, frankly, so is
  my waistline.)

## On the subject of money

Should rescue arrive, I am prepared to *purchase* the rescuing vessel outright,
the island, and possibly the ocean immediately surrounding it. Until then, I am
told my fortune is "not presently useful," a phrase I am choosing to find
charming.

*Drafted by Thurston Howell III, with annotations by Mrs. Lovey Howell, who
insists the bit about the waistline be removed. It stays.*`,
  },
  {
    slug: 'finding-fresh-water-on-the-island',
    title: 'Finding & Purifying Fresh Water',
    author: 'professor',
    summary: 'Springs, rain catchments, and a solar still — because you can go three weeks without rescue but three days without water.',
    tags: ['survival', 'water'],
    body: `# Finding & Purifying Fresh Water

Of all our problems, water is the one that does not negotiate. Food we can hunt
and gather; rescue we can wait for; but the human body keeps a strict and
short-tempered schedule. Fortunately, this island is generous if you know where
to look.

## Sources

1. **The spring** above the second waterfall is our primary supply — cold,
   clear, and reliable. Guard it. Do not bathe upstream of it (a rule we
   instituted after an Incident I will not detail).
2. **Rain catchments.** Broad palm leaves funneled into hollow bamboo. During
   the wet season these fill faster than we can drink.
3. **The solar still.** Dig a pit, place a vessel in the center, cover with
   clear material weighted at the middle. Evaporation condenses and drips clean,
   even from seawater. Slow, but it works while you sleep.

## Purifying

Boil anything you did not draw from the spring. Three minutes at a rolling boil.
A coconut shell over the fire does the job. When in doubt, boil it — dysentery
on a desert island is precisely as bad as it sounds.

## Rationing

Mary Ann tracks the stores; I track consumption. We carry a two-day reserve at
all times. The day we let that reserve lapse is the day the weather turns. It
always is.`,
  },
  {
    slug: 'firstaid-island-injuries',
    title: 'First Aid for Common Island Injuries',
    author: 'maryann',
    summary: 'Coral cuts, sunburn, jellyfish stings, and what to do when Gilligan inevitably falls out of a tree.',
    tags: ['survival', 'health'],
    body: `# First Aid for Common Island Injuries

I'm no doctor — that's the Professor's department, and even he had to read up —
but somebody around here has to keep the bandages rolled and the salve fresh,
and somehow that somebody is me. Here's what we've learned, mostly the hard way,
mostly because of Gilligan.

## Coral cuts

Rinse with fresh water, never seawater into an open cut. Coral cuts fester fast
in the tropics. We keep a poultice of crushed leaves the Professor identified as
mildly antiseptic. Keep it clean, keep it covered, keep an eye on it.

## Sunburn

Aloe grows wild on the south ridge. Split a leaf, apply the gel. Ginger goes
through it faster than anyone, on account of "protecting her instrument," by
which she means her complexion.

## Jellyfish stings

Do **not** rinse with fresh water — it makes it worse. Remove tentacles with a
flat shell (not your bare hand). The Professor has Opinions about the folk
remedies; I'll just say we keep the sting kit by the lagoon.

## Falls from trees

This gets its own section because of how often we use it. Check for a clear
head, count the fingers, ask him his name. If he says "Gilligan" and grins,
he's fine. He's always fine. I don't know how, but he always is.`,
  },
  {
    slug: 'building-the-bamboo-hut',
    title: 'Bamboo Hut Construction & Repair',
    author: 'gilligan',
    // Left as a Draft on purpose: Gilligan's work-in-progress, "pending the
    // Professor's final review." Gives Knowledge Home a status mix.
    status: 'Draft',
    summary: "Gilligan's own how-to. The Professor checked it. Mostly. The part about the roof, anyway.",
    tags: ['survival', 'shelter'],
    body: `# Bamboo Hut Construction & Repair

Hi! The Skipper said I should write down how we build the huts because I've
helped build all of them and also accidentally knocked a few down, so I guess
that makes me an expert on both? The Professor said he'd "check it for accuracy,"
which I think means he's going to rewrite it.

## Step one: the frame

You put four big bamboo poles in the ground for corners. Make them deep. I did
not make them deep one time and the whole hut leaned over like the Skipper after
a long day and then it fell on the Skipper. So: deep.

## Step two: the walls

Weave thinner bamboo and palm between the poles. It's like a really big basket
you can live in. Mary Ann is the best at this. I am the best at carrying things
to Mary Ann.

## Step three: the roof

This is the important part!! Pitch it steep so the rain runs off. Layer the palm
fronds like shingles, starting from the bottom and going up so the water can't
sneak underneath. The Professor drew me a diagram. I only got rain in my bunk
*twice* this season, which is a new record.

## Repairs

After a storm, check every lashing. If something's loose, tell the Skipper. Do
**not** try to fix the Howells' hut yourself while they're in it. I learned that
one the hard way too.

*[Professor's note: It is, astonishingly, all correct. I checked it twice.]*`,
  },
];

(async () => {
  const results = [];
  let createdCount = 0;
  let publishedCount = 0;
  let failCount = 0;

  for (const a of ARTICLES) {
    const wantDraft = a.status === 'Draft';
    try {
      // 1) Idempotent upsert by slug (creates a Draft, or updates in place).
      const up = await beacon(a.author, 'POST', '/entries/upsert', {
        slug: a.slug,
        title: a.title,
        summary: a.summary,
        body_markdown: a.body,
        visibility: 'Organization',
        change_note: 'Gilligan island survival wiki seed',
      });
      const entry = up.data.data ?? up.data;
      const id = entry.id;
      const created = up.data.created;
      if (created) createdCount++;

      // 2) Publish (Draft -> Active) unless this one is meant to stay a Draft.
      //    Already-Active publishes are tolerated; we swallow the lifecycle
      //    error so re-runs stay green.
      let status = entry.status ?? 'Draft';
      if (!wantDraft) {
        try {
          const pub = await beacon(a.author, 'POST', `/beacons/${id}/publish`);
          status = (pub.data.data ?? pub.data)?.status ?? 'Active';
          publishedCount++;
        } catch (e) {
          // Re-run: likely already Active. Re-fetch to report the real status.
          try {
            const cur = await beacon(a.author, 'GET', `/beacons/${id}`);
            status = (cur.data.data ?? cur.data)?.status ?? status;
          } catch {
            /* keep prior status */
          }
        }
      }

      // 3) Tags (duplicate adds are tolerated by the service).
      if (a.tags?.length) {
        try {
          await beacon(a.author, 'POST', `/beacons/${id}/tags`, { tags: a.tags });
        } catch (e) {
          console.log(`  tag warn (${a.slug}): ${e.message}`);
        }
      }

      results.push({ slug: a.slug, author: a.author, status, created });
      console.log(
        `${created ? 'created' : 'updated'}: ${a.title} -> ${status} [${(a.tags || []).join(', ')}] (by ${a.author})`,
      );
    } catch (e) {
      failCount++;
      console.log(`FAILED: ${a.title} (${a.slug}) — ${e.message}`);
      results.push({ slug: a.slug, author: a.author, status: 'FAILED', error: e.message });
    }
  }

  const active = results.filter((r) => r.status === 'Active').length;
  const drafts = results.filter((r) => r.status === 'Draft').length;
  console.log(
    `\nBeacon seed done: ${ARTICLES.length} articles processed — ` +
      `${createdCount} created, ${active} Active, ${drafts} Draft, ${failCount} failed.`,
  );
  if (failCount > 0) process.exit(1);
})().catch((e) => {
  console.error('beacon seed failed:', e.message);
  process.exit(1);
});
