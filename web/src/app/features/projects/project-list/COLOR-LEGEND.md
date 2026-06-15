# Projects table — colour legend

This explains **what every colour on the Projects list table means**. Colour
appears in four places. **Green** (settled) and **blue** (in negotiation) mean
the same thing throughout, but **amber** and **grey** can mean different things
depending on the column — so read those two in context (see the
[note on shared colours](#note-on-shared-colours) below).

The four places colour appears are:

1. **Programs** column — the small acronym chips (e.g. `SP03`).
2. **Mapped %** column — the rounded percentage badge.
3. **Mapping Status** column — the status pill (e.g. *In Negotiation*).
4. **Actions** column — the 💬 negotiation icon (filled vs outline).

> All colours are derived automatically from the data. Nobody sets them by
> hand; they always reflect the current state of each project's mappings.

---

## Quick reference

| Colour | Programs chip | Mapped % badge | Mapping Status pill |
|---|---|---|---|
| 🟢 **Green** | Program **agreed / settled** | **Exactly 100%** — fully allocated | **Locked** — round settled (by negotiation or admin decision) |
| 🔵 **Blue** | Program still **being negotiated** | — | **In Negotiation** — round is active |
| 🟡 **Amber / yellow** | — | **Off 100%** — under- or over-allocated | **Draft** — center hasn't launched the round yet |
| ⚪ **Grey** | Program is a **draft** (not yet launched) | **Nothing agreed yet** (shown as `—`) | **Unmapped** — no active mappings |

---

## 1. Programs column (acronym chips)

Each chip is one program currently mapped to the project. The colour shows
where that specific program's mapping stands.

| State | Colour | Meaning |
|---|---|---|
| 🟢 **Green** | text `#15803d` on `#dcfce7` | The mapping is **agreed / settled** — agreed by both sides, or set by an admin decision. |
| 🔵 **Blue** | text `#3a479c` on `#eef1ff` | The mapping is **in negotiation** — the % allocation isn't agreed yet. (Same blue as the *In Negotiation* status pill.) |
| ⚪ **Grey** | text `#555555` on `#f4f2f2` | The mapping is a **draft** — the center's private setup, not yet launched into a round. |

So in a row showing `SP03` (blue) and `SP04` (green), `SP03` is still being
negotiated while `SP04` has been agreed.

*Rule:* a chip is green when its status is `agreed` or `admin_decision`, blue
when `negotiating`, and grey when `draft`. Removed mappings are not shown.

---

## 2. Mapped % column

The percentage of the project that is **agreed** and committed to programs.
Only **agreed** mappings count — mappings still in negotiation do **not** add to
this number. Each row grades against **exactly 100%** (correctly, fully
allocated).

| State | Colour | Rule |
|---|---|---|
| 🟢 **Green** | text `#15803d` on `#dcfce7` | **Exactly 100%** — fully allocated to programs. |
| 🟡 **Amber** | text `#b45309` on `#fef3c7` | **Anything off 100%** — under-allocated (`> 0%` and `< 100%`) **or** over-allocated (`> 100%`, an error state worth flagging). |
| ⚪ **Grey dash `—`** | `#9ca3af` | `0%` / nothing agreed yet. |

> Example: a row showing **50%** is amber (half allocated, work remains); a row
> at **120%** is also amber (over-allocated — needs fixing). Only an exactly
> **100%** project turns green.

The **"Mapped %" KPI tile** at the top of the page uses green / amber / grey too,
but it grades the **center's whole portfolio against the 90% target** — so the
tile and a single row can differ: a row needs **100%** to go green, while the
portfolio tile needs **90%**.

---

## 3. Mapping Status column (status pill)

The overall negotiation state of the **whole project**. One pill per row.

| Pill label | Colour | Meaning |
|---|---|---|
| **In Negotiation** | 🔵 Blue | A round is **active** — at least one mapping is being negotiated or agreed and the project isn't locked. |
| **Draft** | 🟡 Amber | The center has set up mappings but **hasn't launched** the negotiation round yet (drafts are private to the center). Needs action. |
| **Locked - Solved by negotiation** | 🟢 Green | Round **settled** — everyone agreed and the center locked it. |
| **Locked - Solved by admin decision** | 🟢 Green | Round **settled** by a workflow-admin's final decision. |
| **Unmapped** | ⚪ Grey | The project has **no active mappings**. |

### Why "Locked" is green, not red

Locked is a **good** outcome — it means the round is finished and fully agreed.
The colours follow the *progress* of a round, not a traffic-light intuition:

- 🟢 **Green** = done / settled (locked, admin decision)
- 🔵 **Blue** = in progress (active negotiation)
- 🟡 **Amber** = needs the center to act (draft not yet launched)
- ⚪ **Grey** = nothing started (unmapped)

---

## 4. Negotiation icon (Actions column)

The 💬 (speech-bubbles) button in the **Actions** column opens the project's
negotiation view. Its colour tells you **whose turn it is**, and it is
**role-aware** — a center rep and a program rep looking at the *same* project
can see different colours, because the turn depends on which side you're on.

| State | Appearance | Meaning |
|---|---|---|
| 🟡 **Filled amber, gently pulsing** | warn / amber | **Needs your action** — a live mapping is waiting on *you*: your side hasn't agreed to the current terms yet (or, for the center, a program has requested a removal you must accept or decline). The pulse is the "you're up" cue. Tooltip: *"Negotiation — needs your action."* |
| 🔵 **Filled blue (static)** | info / blue | **Waiting for the other side** — the round is live but it's the counterparty's move; nothing for you to do right now. Tooltip: *"Negotiation — waiting for the other side."* |
| ⚪ **Grey outline (static)** | secondary | **No live negotiation** — the project is locked, fully agreed (ready to lock), all-draft, or unmapped. Tooltip: *"Negotiation."* |

**Who is "you"?**

- **Center rep** (and workflow admin): your action = any negotiating mapping the
  center hasn't confirmed, or a pending removal request to resolve.
- **Program rep**: your action = *your own program's* negotiating mapping that
  you haven't confirmed.
- **Admin / read-only viewer**: no side to act on, so the icon never shows
  amber — a live round just shows blue.

> **The grey state is stricter than the *In Negotiation* status pill.** The icon
> only lights up (amber/blue) when a mapping is **literally mid-negotiation**
> (`negotiating` status). A *ready-to-lock* project (everything agreed, not yet
> locked) shows the blue **pill** but a **grey icon** — there's nothing left to
> negotiate, only to lock.

---

## Note on shared colours

Colour meaning by where it appears:

- **Green** — always "agreed / settled": agreed chips, the `100%` (fully-allocated) badge, the Locked pill.
- **Blue** — "in negotiation": a negotiating chip, the *In Negotiation* pill, and (on the icon) "live, waiting on the other side."
- **Amber** — varies by column: "off 100%, under or over" (Mapped % badge), a "draft" round (Status pill), or **"needs your action now"** (negotiation icon).
- **Grey** — "nothing here": draft chip, no agreed % (the `—` dash), Unmapped pill, or no live negotiation (icon).

So **green** is unambiguous; read **amber** especially in the context of its own column.

---

## For maintainers — where the rules live

| What | File | Symbol |
|---|---|---|
| Program chip colour rules | `project-list.component.html` | `[class.program-badge--negotiating]` (negotiating) and `[class.program-badge--agreed]` (agreed / admin_decision) |
| Program chip colours | `project-list.component.scss` | `.program-badge` (draft/grey), `.program-badge--negotiating` (blue), `.program-badge--agreed` (green) |
| Mapped % thresholds | `project-list.component.ts` | `getMappedClass()` — per-row, green at **100%**; tile-level `mappedClass` — portfolio, green at the **90%** target (intentionally different goals) |
| Mapped % colours | `project-list.component.scss` | `.mapped-badge.kpi-good / .kpi-warn`, `.mapped-dash` |
| Mapping Status → colour | `project-list.component.ts` | `getMappingStatusSeverity()` (PrimeNG `Tag` severity) |
| Mapping Status → label | `project-list.component.ts` | `getMappingStatusLabel()` |
| Status pill palette | PrimeNG theme | `success`=green, `info`=blue, `warn`=amber, `secondary`=grey |
| Negotiation icon colour/tooltip | `project-list.component.ts` | `negotiationIconSeverity()` / `negotiationIconTooltip()`, driven by `project.negotiationTurn` (`'awaiting_me'`/`'awaiting_other'`/`null`) |
| Negotiation icon turn rule (role-aware) | `projects.service.ts` (`findAll` → `buildNegotiationTurnSelect`) | `negotiation_turn` addSelect: center side keys off `center_agreed` + pending removal; program rep off `program_agreed` for their own program; mirrors the dashboard's `!myAgreedFlag` rule |
| Negotiation icon pulse | `project-list.component.scss` | `.negotiation-action--mine` + `@keyframes negotiation-pulse` (amber) |

If you change a threshold or a colour, update **both** the code and this file so
the legend stays accurate.
