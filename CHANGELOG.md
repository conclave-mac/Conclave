# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.5.5] - 2026-11-21

### Added
- A "Roles" menu next to Rounds and Judge (with at least one round) to make a member the devil's advocate or the
  fact-checker, also reachable from the keyboard and with VoiceOver actions on each participant.
- When the judge is also one of the voices, the verdict says so ("also took part in the debate"); otherwise the
  judge is told truthfully whether it took part.

### Changed
- Every member now knows which answer is its own in the critique, revision and final rounds, and critiques are
  labelled by their author, so "answer the critiques about you" works as intended.
- Answers reach the judge in letter order, and backup judges that did not take part come first.
- At most 3 requests in flight per provider key, a 4-minute cap on the verdict phase (at most 4 judges), and images
  only in the opening answers and to the judge: fewer rate-limit errors on free plans.
- Status, warning and error text is darker in light mode and meets the 4.5:1 contrast ratio, with an even stronger
  variant under Increase Contrast. Selected participants show a check mark and an accent border.
- Without any API key, Settings now open on the API Keys pane.

### Fixed
- Engine responses (questions, verdicts, attachments) are no longer stored in the system HTTP cache; the old cache
  is cleared once.
- Live debates use a separate connection pool, so API calls are never stuck behind open streams; a live view that
  receives nothing for 15 seconds rechecks the debate and catches up.
- The header duration no longer includes follow-up questions (old discussions are corrected too).
- The language of the verdict is detected more reliably (Portuguese and Dutch added; uncertain cases fall back to
  the question's language rule instead of a wrong guess).
- A slow member is no longer cut from a round when the others failed quickly, nor while it waits for a free slot
  with its provider.

## [0.5.4] - 2026-11-21

### Changed
- New logo and app icon: a c within a c around a gold dot, the council's voices around the verdict, in the app's
  warm palette. The icon fills the square like Apple's own icons and has proper dark and tinted variants.

## [0.5.3] - 2026-11-20

### Added
- Answers and the verdict now stream in while the models write them, with a "Writing…" note under the card.
- Errors say what happened and what to do (busy service, exhausted quota, rejected key, network, retired model,
  interrupted answer, too long…), in the interface language. The provider's original message stays in the tooltip.

### Changed
- Faster startup: the engine starts while the window is being built and the keychain is read off the main thread
  (on an older Intel Mac the window is ready about 1.5 s sooner).
- The sidebar reacts faster to the pointer: hovering a row no longer redraws the whole list. Resizing the window is
  lighter too.
- A Gemini per-minute limit is no longer reported as an exhausted quota: Conclave waits and tries again.

### Fixed
- Reopening a discussion brings back the exact reading position (it was off by the toolbar height).
- The last rows of the history no longer slide under the settings button.
- In-app updates: the swap is undone if another copy of the app starts at that moment, and leftover temporary files
  are cleaned up after quitting during a download or after a crash.
- Image retries: Qwen keeps receiving images after an output-limit error, and a request that is too long because of
  its text is no longer retried without images for nothing.

## [0.5.2] - 2026-11-18

### Fixed
- The verdict and the discussion title are written in the language of the question: with Gemini as judge, an
  Italian question could get an English verdict.

## [0.5.1] - 2026-11-18

### Added
- Roles are shown next to each participant in the discussion header and on the critique cards, and "Relaunch the
  council" keeps the roles of the discussion.
- Qwen 3.8 27B on Groq now receives attached images as real images (up to 3 per request), like Gemini.
- Accessibility: VoiceOver reads each answer card as one item, a "Phases" rotor jumps between phases, and a
  finished answer is announced once. "Increase contrast" and "Reduce transparency" make the sidebar opaque and
  secondary text darker.
- Reopening a discussion brings you back to where you were reading.

### Changed
- The default OpenRouter voice is now Nemotron: OpenRouter no longer offers DeepSeek for free. Saved DeepSeek
  voices are kept and the app explains that they need a paid model.
- Cerebras is shown as credits-only: it no longer has a permanent free plan.
- Follow-up questions no longer resend the images of every earlier turn.
- The keychain is read once per launch instead of twice (about 0.7 s faster startup on an older Intel Mac).

### Fixed
- In-app updates: the disk image is unmounted even if the first attempt fails, temporary files are removed when
  quitting during a download, Cancel during "Verifying…" stops at once, the swap waits for a second running copy
  of the app, and an update postponed by cancelling the quit is installed at the next quit instead of being lost.
- Groq: Qwen no longer skips rounds when it hits the per-minute output token limit.
- Attached photos and charts without recognizable text are accepted when a picture can be sent.
- The new app's signature is checked again right before an update replaces the old one.

## [0.5.0] - 2026-11-17

### Added
- Assignable roles: right-click a participant in the composer to make it the devil's advocate or the fact-checker
  in the critique round.
- Attached images are now sent to Gemini as real images (downscaled), not only as recognized text. Other models
  keep receiving the recognized text.
- Updates are checked at every launch.

### Fixed
- Sidebar: a discussion started from outside the app now leaves the "in progress" state on its own, and the list
  scrolls to the top when a new discussion arrives.

## [0.4.1] - 2026-11-16

### Changed
- No changes to the app: this release checks that Conclave 0.4.0 updates itself with "Install and Relaunch".

## [0.4.0] - 2026-11-16

### Added
- Updates install from inside the app: "Install and Relaunch" downloads the release for your Mac, checks its
  checksum and code signature, then quits and reopens Conclave on the new version. If a discussion is in
  progress it can wait until it finishes; if anything fails, the download page is offered as before.
- Print and export discussions as PDF from the File menu.

### Fixed
- Quitting with unsaved changes in Settings now asks whether to save them.
- Debate phase cards use the full width, and the timeline line stops at phases still in progress.
- Table columns in answers are sized from the real width of their words and lines.
- The engine error page shows the end of the log as a left-aligned code block.

## [0.3.1] - 2026-11-15

### Changed
- Warmer, more modern look: warm paper background in light mode and warm graphite in dark mode, warm sidebars
  (main window and Settings) and a soft warm selection instead of blue.
- History is a single list, without "Today", "Yesterday" and other date groups, and without the old
  "Follow-up" label.
- New start-screen lines about the council, depending on the time of day.
- Folding sections ("Detailed instructions", "Show the models") open by clicking their title, not only the arrow.
- Release notes come from this changelog.

### Fixed
- The update notice no longer shows raw GitHub text ("Full Changelog" links, Markdown symbols).

## [0.3.0] - 2026-11-15 — Beta 3

### Added
- "The debate at a glance" below the verdict: what the models agree on, errors found during the debate and
  disagreements left open.

### Changed
- API Keys settings rebuilt: one row per provider with its status in words; opening a row shows three numbered
  steps (open the provider's site, paste the key, check it). Detailed instructions stay folded away.
- Settings window title follows the open pane; no repeated page titles.
- Visual review for macOS 26: no white band under the toolbar (content now scrolls beneath it), composer and
  follow-up controls wrap cleanly in narrow windows, round numbers in the debate timeline, clearer Markdown
  headings, tables and code, branded engine start and error page, theme picker with labels, more readable
  accent in dark mode.

### Fixed
- "Search the web" no longer looks switched on when no model can search.
- The question is shown once in the debate header until the judge writes a title.
- Sidebar no longer shows the blue system selection on the first click.

## [0.2.1] - 2026-11-14

### Changed
- Separate downloads for Apple Silicon (~44 MB) and Intel (~47 MB) instead of one universal DMG (~89 MB):
  the bundled Node.js runtime is almost all of the app, so each Mac now downloads only its own.
  Installed app size is halved too.
- Faster launch: the engine starts while the window is being built and no longer waits for the login
  shell to report its `PATH` (read once, then refreshed in the background). The app is ready about
  0.6–0.8 s sooner on a 2014 Intel Mac.

## [0.2.0] - 2026-11-14 — Beta 2

### Added
- Continue the conversation in the same debate after the verdict: quick answer from the judge or another
  model, or call the council again. Replaces "Follow up" debates.
- Structured verdict: short answer first, reliability rating, "where they disagree" table, what to verify.
- Attachments (PDF, text, images) with text extracted on the Mac (PDFKit, Vision OCR).
- Optional web search before the debate (Claude Code or GPT-OSS on Groq).
- Fast / Standard / Deep presets with a time estimate; character counter for long questions.
- Settings ask before discarding unsaved changes.

### Changed
- Sharper debate prompts: answer first, change position only for better arguments, treat pasted text as data.
- Repository renamed to `conclave-mac/Conclave`.

### Fixed
- Live updates no longer go silent while a slow judge is writing (SSE keep-alive).
- The verdict appears as soon as a live debate ends, and the follow-up field stays editable.
- Follow-up turns that fail without a final event are closed instead of staying "in progress";
  web search skips Claude when it is unavailable.

## [0.1.0] - 2026-11-11 — Beta 1

First public release: a **beta, work in progress**. Expect rough edges and changes between
versions.

### Added

- Debates in rounds between up to 10 models: independent answers, anonymous cross-critique with a
  randomly chosen devil's advocate, revision, final position (0–3 rounds), then a verdict by a
  judge of your choice. Round 3 is skipped when nobody changes position.
- Judge fallback: if the chosen judge fails, Claude and then the other participants are tried.
- Short debate titles written by the judge; follow-up questions on a finished debate.
- One voice per model family with an automatic fallback chain: slow, rate-limited or retired
  variants are replaced by the next one, and the variant that answers is preferred afterwards.
- Startup health check that replaces models retired by the provider with the best catalog match
  and saves the choice; results cached for 12 hours.
- Providers: Claude through the official Claude Code CLI (existing subscription) and any
  OpenAI-compatible API (Gemini, Groq, OpenRouter, Mistral, Cerebras, OpenAI).
- Native macOS interface (AppKit + SwiftUI): sidebar history with search (case- and
  accent-insensitive), live debate view that follows the rounds, Markdown renderer with tables,
  Markdown export, text zoom, light/dark/system theme, Italian and English localization, open at
  login and menu bar extra.
- Debates left running in the background keep being tracked, with notification and Dock badge.
- Weekly update check against GitHub Releases (opt-out, never installs anything).
- macOS 26 app icon built with Icon Composer.
- Universal app (Apple Silicon + Intel) with Node 24 bundled, distributed as a DMG with SHA-256
  checksums.
- Engine stress suite (`npm run test:chaos`) with a mock provider: blocked, slow, rate-limited,
  failing, empty, oversized and retired models, cancellation and hostile input.

### Security

- API keys stored in the macOS Keychain and passed to the engine on standard input.

### Known issues

- The app is not notarized: the first launch needs "Open Anyway" in System Settings ▸ Privacy &
  Security.
- Without an Apple Developer Team ID, macOS asks once for your login password to read the API keys
  after each update (choose "Always Allow").
- Local engine bound to `127.0.0.1`, `Host` header check, per-session bearer token.
- Secrets masked in provider errors and in `server.log`.
- Data folder `0700`, files `0600`; atomic writes for settings and health cache.
- Claude CLI run without tools, MCP servers or user settings, and stopped on shutdown.

[Unreleased]: https://github.com/conclave-mac/Conclave/compare/v0.5.5...HEAD
[0.5.5]: https://github.com/conclave-mac/Conclave/releases/tag/v0.5.5
[0.5.4]: https://github.com/conclave-mac/Conclave/releases/tag/v0.5.4
[0.5.3]: https://github.com/conclave-mac/Conclave/releases/tag/v0.5.3
[0.5.2]: https://github.com/conclave-mac/Conclave/releases/tag/v0.5.2
[0.5.1]: https://github.com/conclave-mac/Conclave/releases/tag/v0.5.1
[0.5.0]: https://github.com/conclave-mac/Conclave/releases/tag/v0.5.0
[0.4.1]: https://github.com/conclave-mac/Conclave/releases/tag/v0.4.1
[0.4.0]: https://github.com/conclave-mac/Conclave/releases/tag/v0.4.0
[0.3.1]: https://github.com/conclave-mac/Conclave/releases/tag/v0.3.1
[0.3.0]: https://github.com/conclave-mac/Conclave/releases/tag/v0.3.0
[0.2.1]: https://github.com/conclave-mac/Conclave/releases/tag/v0.2.1
[0.2.0]: https://github.com/conclave-mac/Conclave/releases/tag/v0.2.0
[0.1.0]: https://github.com/conclave-mac/Conclave/releases/tag/v0.1.0
