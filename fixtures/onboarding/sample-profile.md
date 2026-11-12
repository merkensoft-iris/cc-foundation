# Sample onboarding profile: the reference scenario, as an essay

- **What this is:** a sample of the document a user could upload instead of typing the Command Center (CC) onboarding answers. CC would infer the answers from it, and the user would approve them, changing only what is wrong (owner decision Q10 (c), 10 Nov 2026; `docs/design/01-onboarding-and-frameworks.md` §3.2). Inferring answers needs the AI layer, so this file is the test input of the P3 extractor (AC-01-11). The same answers, structured, are in `sample-profile.json` for `cc-axi onboarding apply --file` in P1 (AC-01-10).
- **Whose voice:** the owner of the reference scenario in `docs/design/`: two fictional companies, Alderwick and Quillmarsh. Every name in it is fictional.
- **Facts:** every fact comes from the design docs unless it carries **[sample]**. A [sample] fact is invented filler, there only so that every question has an answer. Replace it with the real answer before this file is used for anything but a test.
- **Questions:** 67, listed in the table at the end. The numbering follows the question list in `docs/design/01-onboarding-and-frameworks.md` §3.1, which is the authority.
- **Privacy:** following the scenario's rules (README §4), no client is named and the client contact has no name here. The passphrase is not written down.

---

## The owner's workspace

### 1. My workspace (step S1)

I call this workspace **Main**. I work in India, so my time zone is **Asia/Kolkata**, and my work week is **Monday to Friday**. My working hours come in two parts: **09:00 to 17:30**, and then **18:00 to 23:00** in the evening.

Some times are protected, and nothing may be booked into them:

- The **Evening block**, every weekday from **18:00 for five hours** (300 minutes). It is a **hard** block: never schedule anything into it.
- My **afternoon break**, every weekday from **14:00 for one hour**. Also a **hard** block.
- **Deep block A**, every weekday from **09:45 for three hours**. This one is **soft**: CC may suggest a meeting there, but I have to confirm it.

I give myself a budget of **240 minutes a week** for all meetings and reviews together. My quiet hours run from **23:30 to 08:00**, and nothing should reach me then.

For backups, I have set a passphrase **[sample]**. It is not written in this document, and CC never stores it. Off-machine copies go to **the Google Drive desktop app's synced folder** on this machine **[sample]**, so the sync client carries the encrypted archives off the machine.

### 2. What I run here (step S2)

I run two things in Command Center:

1. **Alderwick**, a company.
2. **Quillmarsh**, a company.

Both companies stand on their own, with no parent, and I list no client engagement or project under either of them. The outcome of both is **mine**. Both run on my own time, **Asia/Kolkata**.

### 3. About each workstream (step S3)

**Alderwick.** It is me, mostly alone: a headcount of **1**, a leadership group of **1**, and **no teams under leads**. It is at the **early revenue** stage. It mixes **services and product**. The main goal is to **grow revenue**, through **a few priorities** rather than one dominant outcome, so it has **no deadline**. I have **never used a framework** for it, so there is nothing to keep. I want the **light** version, and nothing about it is **sensitive**: normal confidentiality. My note on it: "Alderwick is me, mostly alone; client project work runs in the evenings, and LinkedIn posts and the blog bring in consulting leads." **[sample: the note's wording; its facts are in the scenario]**

**Quillmarsh.** Also me alone: headcount **1**, leadership group **1**, **no teams under leads**. It is **pre-revenue** and a **product** business. The main goal is to **launch**, through **a few priorities**, with **no deadline**. **No existing framework**, so nothing to keep. **Light**, and **normal** confidentiality. My note on it: "Quillmarsh is a product I am building alone; shipping one thing every week matters most, and the website is hosted at Hostinger." **[sample: the note's wording; its facts are in the scenario]**

### 4. The recommendation (step S4)

I **accept the recommendation** for each workstream:

- Alderwick: **`eos-lite`, solo**, with the client-services, product and marketing packs, merged with Quillmarsh into one weekly CEO review.
- Quillmarsh: **`eos-lite`, solo**, with the product and marketing packs, in the same merged weekly CEO review.

### 5. Tailoring (step S5)

**Meeting times.** My meetings are: a **daily start, Monday to Friday 09:00 to 09:10**; a **daily shutdown, 17:20 to 17:30**; and the **weekly CEO review for Alderwick and Quillmarsh on Fridays 15:00 to 16:00** On the **last Friday of each month** the monthly review takes the weekly review's place and runs **15:00 to 17:00**. **Quarterly planning** is a half day from 09:45 on the second-to-last Friday of each quarter, first on **18 December 2026**, and the **annual review** is on **11 December 2026**.

**Merging.** **Yes, merge** the weekly meetings of the two companies I run alone into one weekly CEO review.

**Scorecard lines.** All of them are mine to own:

- Alderwick: **LinkedIn posts published, at least 3 a week**; **blog plan on schedule**, yes or no each week; **consulting leads, at least 2 a week**; **client hours logged against the 25 planned, 90 to 110 percent**; **invoices raised (INR), per plan**; and **action items closed on time, at least 80 percent**, shared with Quillmarsh.
- Quillmarsh: **LinkedIn posts published, at least 2 a week**; **shipped one thing this week**, yes or no, from merged pull requests once GitHub is connected; **active users or pilots, per plan**; and the shared line on action items closed on time.

Until each connector exists, I enter these values by hand.

**First goals for this quarter.** Alderwick has **three priorities**: win two consulting clients, publish the blog on its plan every week, and keep the client project work within its planned hours **[sample: the three priorities' wording]**. Quillmarsh has **two priorities**: launch the first public version, and sign the first pilot user **[sample]**.

**Decisions.** For both companies, decisions are made by **a single decider**, me, and a **one-way-door decision gets a short memo first: yes**.

**Ownership.** I work alone, so **I own every area**. The only steps I do not own are the ones another person performs, such as the client contact signing a statement of work.

**Review strictness.** **Every item needs my review** before it closes. The only items that may **close on their own checks** are calendar checks and measure checks.

**Escalation.** I keep the **defaults**: an unfinished item escalates to E2 after it has been **carried twice**, and to E3 after **four carries or 30 days overdue**.

**What AI may see.** For **Alderwick and Quillmarsh, AI may see everything (allow)**.

**Who is told when items close.** **Nobody**: I close my own items.

### 6. My week (step S6)

I **keep the composed grid as CC proposes it**, with the times above. I **keep the daily start and the daily shutdown**. The quarterly planning and the annual review start at 09:45 inside the soft Deep block A, and I **confirm that overlap**.

The grid comes to **160 minutes a week**, about 174 with the monthly review averaged in, which is **within my 240-minute budget**, so CC does not ask me to fix the budget. Every required meeting finds a slot outside my hard blocks, so CC does not ask me to move a meeting or a block either.

### 7. My tools (step S7)

The tools I use, by category:

- **Calendar:** **Google Calendar**, for everything.
- **Email:** **Gmail**, two mailboxes: the **Alderwick mailbox** and the **Quillmarsh mailbox**.
- **Chat:** **WhatsApp**, on the Alderwick business number.
- **Social:** **LinkedIn**, for Alderwick and Quillmarsh posts.
- **Scheduling:** **Hootsuite** for Alderwick and Quillmarsh, **if decision D-0008 picks it**. That decision is open until 27 November 2026.
- **Blog/CMS:** **WordPress**, for the Alderwick blog.
- **Hosting:** **Hostinger**, for the Quillmarsh website.
- **Code:** **GitHub**, for Quillmarsh and Alderwick.
- **Time tracking:** **Toggl Track**, for Alderwick client hours.
- **CRM, docs, analytics, job boards and accounting:** **none I want CC to know about yet [sample]**.

**My team's tasks.** I have **no team tracker, Jira or Linear, so CC should use a Google Sheet, for Alderwick and Quillmarsh, later, once a tracker connector exists [sample]**.

**How each tool connects**, by the label I give each account:

- **`gcal-main`**: the Google Calendar connector, for all workstreams.
- **`gmail-alderwick`**: the Gmail connector, for Alderwick.
- **`gmail-quillmarsh`**: the Gmail connector, for Quillmarsh.
- **`github-main`**: the GitHub connector, for Quillmarsh and Alderwick.
- **`linkedin-self`**: the LinkedIn connector, for Alderwick and Quillmarsh.
- **`whatsapp-alderwick`**: the WhatsApp Web connector, for Alderwick.
- **`wordpress-alderwick`**: the WordPress connector, for Alderwick.
- **`hootsuite-main`**: the Hootsuite connector, for Alderwick and Quillmarsh, **later**, once D-0008 decides.
- **`toggl-main`**: the Toggl Track connector, for Alderwick.
- **Hostinger** has no connector, so I choose **find with AI** for it.
- Until a connector ships, I keep the tool on **manual**.

**Calendars.** CC writes to **one new calendar in my Google account, named "Command Center"** **[sample: the calendar's name]**. **All workstreams sync to `gcal-main`**, and that calendar is the **primary** target for every series; **no mirror** calendar **[sample: no mirror]**.

### 8. AI (step S8)

I use the **Claude CLI**, with my own Claude Code login **[sample]**. Because an adapter exists for it, there is **no provider to find with AI [sample]**. The model is **`claude-opus-5-5`** **[sample]**. **No per-task routing**: every task uses that one provider and model **[sample]**. My **daily budget is 5 US dollars [sample]**.

### 9. Commit (step S9)

I **confirm the full preview** of every record and every outward action. I **approve the first calendar batch**, so the meetings start in the week of **9 November 2026** and the first weekly review is on **13 November 2026**. I **sign in to each service one at a time**, right after the commit. Services I have no connector for yet (WhatsApp, WordPress, Hootsuite, Toggl, LinkedIn) I **skip** for now **[sample: which sign-ins are skipped]**.

---

## Question map

**Source** is the doc and section in `docs/design/` that states the fact. **SAMPLE** means invented filler. **MIXED** means the answer has design facts and a [sample] part. "Not asked" means the condition for the question did not fire in the scenario, and the design fact says why. **(+)** marks the 6 answers the types hold separately from the question they are asked with (01 §3.1).

| #   | Step | Question                                                                | Answering sentence                                                                                                                                                                                         | Source                                                                                    |
| --- | ---- | ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| 1   | S1   | Workspace name                                                          | "I call this workspace **Main**."                                                                                                                                                                          | 01 §7.1 `displayName`                                                                     |
| 2   | S1   | Time zone                                                               | "I work in India, so my time zone is **Asia/Kolkata**, and my work week is …"                                                                                                                              | 01 §7.1 `timeZone`                                                                        |
| 3   | S1   | Work week                                                               | "… my work week is **Monday to Friday**."                                                                                                                                                                  | 01 §7.1 `workweek`                                                                        |
| 4   | S1   | Working hours                                                           | "My working hours come in two parts: **09:00 to 17:30**, and then **18:00 to 23:00** in the evening."                                                                                                      | 01 §7.1 `workingHours`                                                                    |
| 5   | S1   | Protected blocks: "times nothing may be booked into"                    | "The **Evening block**, every weekday from **18:00 for five hours** … My **afternoon break**, every weekday from **14:00 for one hour** … **Deep block A**, every weekday from **09:45 for three hours**." | 01 §7.1 `protectedBlocks`                                                                 |
| 6   | S1   | (+) Each block: hard or soft?                                           | "It is a **hard** block … Also a **hard** block … This one is **soft**: CC may suggest a meeting there, but I have to confirm it."                                                                         | 01 §7.1 `policy`; 02 §4.6 rule 1                                                          |
| 7   | S1   | Weekly time budget for meetings and reviews                             | "I give myself a budget of **240 minutes a week** for all meetings and reviews together."                                                                                                                  | 01 §7.1 `weeklyManagementMinutes`                                                         |
| 8   | S1   | Quiet hours                                                             | "My quiet hours run from **23:30 to 08:00**, and nothing should reach me then."                                                                                                                            | 01 §7.1 `quietHours`; 02 §10 rule 4                                                       |
| 9   | S1   | Backup passphrase (skippable)                                           | "For backups, I have set a passphrase **[sample]**."                                                                                                                                                       | SAMPLE (scenario fixture has no backup; 04 §9.1)                                          |
| 10  | S1   | Off-machine backup destination (skippable)                              | "Off-machine copies go to **the Google Drive desktop app's synced folder** on this machine **[sample]** …"                                                                                                 | SAMPLE (option from 01 §3 S1, 04 §9.1 rule 5)                                             |
| 11  | S2   | "List everything you want to run here"                                  | "**Alderwick**, a company. **Quillmarsh**, a company."                                                                                                                                                     | 01 §7.1 `workstreams`; README §4                                                          |
| 12  | S2   | Kind                                                                    | "**Alderwick**, a company." / "**Quillmarsh**, a company."                                                                                                                                                 | 01 §7.1 `kind`                                                                            |
| 13  | S2   | Name                                                                    | "**Alderwick** … **Quillmarsh**"                                                                                                                                                                           | 01 §7.1 `name`                                                                            |
| 14  | S2   | Parent                                                                  | "Both companies stand on their own, with no parent …"                                                                                                                                                      | 01 §7.1 (no `parentKey`)                                                                  |
| 15  | S2   | Whose outcome is it?                                                    | "The outcome of both is **mine**."                                                                                                                                                                         | 01 §7.1 `principal`                                                                       |
| 16  | S2   | (+) Relationship to that person                                         | Not asked: every outcome is mine, so no workstream has another person as its principal.                                                                                                                    | 01 §7.1 (`principal.kind = self` throughout)                                              |
| 17  | S2   | (+) Their consent                                                       | Not asked: as row 16. The client contact's consent is recorded on the person, not at S2.                                                                                                                   | 01 §7.1; 03 §13.3; M3 (01 §6.3)                                                           |
| 18  | S2   | Time zone (per workstream; triggers the US daylight-saving check)       | "Both run on my own time, **Asia/Kolkata**." No workstream has its own zone, so the US daylight-saving check never fires in the scenario.                                                                  | README §3 (time zones); 01 §7.1 `timeZone`; 02 §8.1 notes; owner call A, 10 Nov 2026      |
| 19  | S3   | Headcount                                                               | "… a headcount of **1** …" (each workstream)                                                                                                                                                               | 01 §7.1 `headcount`                                                                       |
| 20  | S3   | Leadership group size                                                   | "… a leadership group of **1** …" (each workstream)                                                                                                                                                        | 01 §7.1 `leadershipGroupSize`                                                             |
| 21  | S3   | Teams under leads?                                                      | "… and **no teams under leads**." (each workstream)                                                                                                                                                        | 01 §7.1 `hasTeamsUnderLeads`                                                              |
| 22  | S3   | Stage                                                                   | "It is at the **early revenue** stage." / "It is **pre-revenue** …"                                                                                                                                        | 01 §7.1 `stage`                                                                           |
| 23  | S3   | Business type                                                           | "It mixes **services and product**." / "… and a **product** business."                                                                                                                                     | 01 §7.1 `businessType`                                                                    |
| 24  | S3   | Primary goal                                                            | "The main goal is to **grow revenue** …" / "… to **launch** …"                                                                                                                                             | 01 §7.1 `primaryGoal`                                                                     |
| 25  | S3   | Goal shape                                                              | "… through **a few priorities** rather than one dominant outcome …" (each workstream)                                                                                                                      | 01 §7.1 `goalShape`                                                                       |
| 26  | S3   | Deadline                                                                | "… so it has **no deadline**." (each workstream)                                                                                                                                                           | 01 §7.1 (no `deadline`)                                                                   |
| 27  | S3   | Role type (job search only)                                             | Not asked: no workstream is a job search.                                                                                                                                                                  | 01 §7.1 (no `job_search` workstream; README §4)                                           |
| 28  | S3   | Target roles (job search only)                                          | Not asked: as row 27.                                                                                                                                                                                      | 01 §7.1 (no `job_search` workstream; README §4)                                           |
| 29  | S3   | Existing framework                                                      | "I have **never used a framework** for it …" (each: "**No existing framework**")                                                                                                                           | 01 §7.1 `existingFramework`                                                               |
| 30  | S3   | Keep the existing framework?                                            | "… so there is nothing to keep."                                                                                                                                                                           | follows from 01 §7.1 (`none`; R1 needs `keepExisting`, 01 §6.2)                           |
| 31  | S3   | Weight preference                                                       | "I want the **light** version …" (each: "**Light**")                                                                                                                                                       | 01 §7.1 `weightPreference`                                                                |
| 32  | S3   | Confidentiality                                                         | "… nothing about it is **sensitive**: normal confidentiality." / "… and **normal** confidentiality."                                                                                                       | 01 §7.1 `confidentiality`                                                                 |
| 33  | S3   | Notes                                                                   | "My note on it: "Alderwick is me, mostly alone; client project work runs in the evenings …"" (one note per company)                                                                                        | MIXED: wording SAMPLE; facts from 01 §7.1, 01 §7.1 protected blocks, 02 §8.2, 05 §16      |
| 34  | S4   | Accept the recommendation, or pick one of the two alternatives?         | "I **accept the recommendation** for each workstream: … **`eos-lite`, solo** …"                                                                                                                            | 01 §7.2; README §4                                                                        |
| 35  | S5   | Q-T01 Day, time and length of each required meeting                     | "My meetings are: a **daily start, Monday to Friday 09:00 to 09:10** … and the **weekly CEO review for Alderwick and Quillmarsh on Fridays 15:00 to 16:00** …"                                             | 01 §7.3; 02 §8.1                                                                          |
| 36  | S5   | Q-T02 Merge same-cadence meetings of workstreams you run alone?         | "**Yes, merge** the weekly meetings of the two companies I run alone into one weekly CEO review."                                                                                                          | 01 §8 Q-T02 default; M8 (01 §6.3)                                                         |
| 37  | S5   | Q-T03 Scorecard lines (owner, unit, target, source)                     | "Alderwick: **LinkedIn posts published, at least 3 a week** … Until each connector exists, I enter these values by hand."                                                                                  | 02 §8.2 (K-0001 to K-0009)                                                                |
| 38  | S5   | Q-T04 First priorities, WIG or goals for this quarter                   | "Alderwick has **three priorities**: … **[sample: the three priorities' wording]**. Quillmarsh has **two priorities** … **[sample]**."                                                                     | MIXED: count (Alderwick 3) from 01 §8 Q-T04; priority wording and Quillmarsh count SAMPLE |
| 39  | S5   | Q-T05 How are decisions made?                                           | "For both companies, decisions are made by **a single decider**, me …"                                                                                                                                     | 01 §8 Q-T05 default                                                                       |
| 40  | S5   | (+) Q-T05 Memo for one-way doors?                                       | "… and a **one-way-door decision gets a short memo first: yes**."                                                                                                                                          | 01 §8 Q-T05 default; 01 §5.3 `decision.memoForOneWayDoors`                                |
| 41  | S5   | Q-T06 Who owns which area?                                              | "I work alone, so **I own every area**. The only steps I do not own are the ones another person performs, such as the client contact signing a statement of work."                                         | 01 §8 Q-T06 default; 03 §13.3                                                             |
| 42  | S5   | Q-T07 How strict is review?                                             | "**Every item needs my review** before it closes. The only items that may **close on their own checks** are calendar checks and measure checks."                                                           | 01 §8 Q-T07 default                                                                       |
| 43  | S5   | Q-T08 When does an unfinished item escalate?                            | "I keep the **defaults**: … E2 after it has been **carried twice**, and to E3 after **four carries or 30 days overdue**."                                                                                  | 01 §8 Q-T08 defaults                                                                      |
| 44  | S5   | Q-T09 What may AI see for this workstream?                              | "For **Alderwick and Quillmarsh, AI may see everything (allow)**."                                                                                                                                         | 01 §8 Q-T09 default                                                                       |
| 45  | S5   | Q-T10 Which grounding files define the candidate?                       | Not asked: no workstream has a job-search pack.                                                                                                                                                            | 01 §8 Q-T10 (applies to pack.job-search* only)                                            |
| 46  | S5   | Q-T11 Who is told when items close?                                     | "**Nobody**: I close my own items."                                                                                                                                                                        | 01 §8 Q-T11 default                                                                       |
| 47  | S6   | Adjust the times in the composed weekly grid                            | "I **keep the composed grid as CC proposes it**, with the times above."                                                                                                                                    | 01 §7.3; 02 §8.1                                                                          |
| 48  | S6   | Keep the daily start and daily shutdown?                                | "I **keep the daily start and the daily shutdown**."                                                                                                                                                       | 02 §4.5; 02 §8.1 (`ser_daily_start`, `ser_daily_shutdown`)                                |
| 49  | S6   | Confirm overlaps with a soft block, or a meeting outside working hours  | "The quarterly planning and the annual review start at 09:45 inside the soft Deep block A, and I **confirm that overlap**."                                                                                | 02 §8.1 notes; 02 §4.6 rule 1                                                             |
| 50  | S6   | Over the time budget: which fix? (only if T1 fires)                     | Not asked: "The grid comes to **160 minutes a week** … **within my 240-minute budget**, so CC does not ask me to fix the budget."                                                                          | 01 §7.3 (T1 passes)                                                                       |
| 51  | S6   | A required meeting has no slot (only if T2 fires)                       | Not asked: "Every required meeting finds a slot outside my hard blocks, so CC does not ask me to move a meeting or a block either."                                                                        | AC-01-05 (01 §11); 01 §6.4 T2                                                             |
| 52  | S7   | Which tools do you use, by category?                                    | "**Calendar:** **Google Calendar** … **Hosting:** **Hostinger** … **CRM, docs, analytics, job boards and accounting:** **none I want CC to know about yet [sample]**."                                     | MIXED: 05 §16 table; the five empty categories SAMPLE                                     |
| 53  | S7   | Where does your team track tasks? (Jira / Linear / none → Google Sheet) | "I have **no team tracker, Jira or Linear, so CC should use a Google Sheet [sample]**."                                                                                                                    | SAMPLE (question added by owner decision C2, 10 Nov 2026: 01 §3.1 row 53, 05 §16 item 4)  |
| 54  | S7   | For which workstreams?                                                  | "**`gmail-alderwick`**: the Gmail connector, for Alderwick." (one line per binding)                                                                                                                        | 05 §16 table, Workstreams column                                                          |
| 55  | S7   | Account label (optional)                                                | "**How each tool connects**, by the label I give each account: **`gcal-main`** … **`toggl-main`** …"                                                                                                       | 05 §16 binding labels                                                                     |
| 56  | S7   | For each tool: a connector, manual, find with AI, or later?             | "**Hostinger** has no connector, so I choose **find with AI** for it." / "**`hootsuite-main`** … **later**, once D-0008 decides." / "Until a connector ships, I keep the tool on **manual**."              | 05 §16; 03 §13.5 (D-0008); 09 §6 P1 scope (S7 records manual or later)                    |
| 57  | S7   | Calendars: which calendars?                                             | "CC writes to **one new calendar in my Google account, named "Command Center"** **[sample: the calendar's name]**."                                                                                        | MIXED: `gcal-main` from 05 §16; calendar choice and name SAMPLE                           |
| 58  | S7   | Which workstreams sync where?                                           | "**All workstreams sync to `gcal-main`** …"                                                                                                                                                                | 05 §16 (`gcal-main`, all); 02 §9.6                                                        |
| 59  | S7   | (+) Is each calendar target primary or a mirror?                        | "… and that calendar is the **primary** target for every series; **no mirror** calendar **[sample: no mirror]**."                                                                                          | MIXED: one primary per series from 02 §9.6 rule 4; no mirror SAMPLE                       |
| 60  | S8   | Which AI provider?                                                      | "I use the **Claude CLI**, with my own Claude Code login **[sample]**."                                                                                                                                    | SAMPLE (option from 01 §3 S8, 04 §6.3)                                                    |
| 61  | S8   | (+) A provider with no adapter: name it for find with AI                | "Because an adapter exists for it, there is **no provider to find with AI [sample]**."                                                                                                                     | SAMPLE (follows from Q60; 01 §4 `discover`, 06 §3)                                        |
| 62  | S8   | Model                                                                   | "The model is **`claude-opus-5-5`** **[sample]**."                                                                                                                                                         | SAMPLE (04 §6.3 names it as the `anthropic_api` default)                                  |
| 63  | S8   | Per-task routing (optional)                                             | "**No per-task routing**: every task uses that one provider and model **[sample]**."                                                                                                                       | SAMPLE                                                                                    |
| 64  | S8   | Daily budget                                                            | "My **daily budget is 5 US dollars [sample]**."                                                                                                                                                            | SAMPLE (04 §6.6)                                                                          |
| 65  | S9   | Confirm the full preview of every record and every outward action       | "I **confirm the full preview** of every record and every outward action."                                                                                                                                 | README §4 (onboarding on 2026-11-04); C-01-01                                             |
| 66  | S9   | Approve the first calendar write batch                                  | "I **approve the first calendar batch**, so the meetings start in the week of **9 November 2026** and the first weekly review is on **13 November 2026**."                                                 | README §4; 02 §9.2 rule 5                                                                 |
| 67  | S9   | Sign in to each service                                                 | "I **sign in to each service one at a time**, right after the commit. Services I have no connector for yet … I **skip** for now **[sample: which sign-ins are skipped]**."                                 | MIXED: one at a time and skippable from 05 §16 item 3; which are skipped SAMPLE           |
