# Pinterest Bot Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement task-by-task.

**Goal:** Deliver a personal Pinterest video downloader for Cloudflare Workers.
**Architecture:** JavaScript modules parse Pinterest pages and stream MP4 to Telegram. D1 atomically claims webhook updates. Setup scripts register the webhook without storing secrets in git.
**Tech Stack:** Node 24 for tests, Workers Web APIs, D1, Wrangler 4.
**Spec:** ../specs/2026-10-01-pinterest-bot-design.md

## Global Constraints
- Personal chat and configured owner only; authenticated webhook.
- No advertising, subscription checks, production mocks or invented URLs.
- MP4 only; preserve bytes and audio; upload at most 49,000,000 bytes.
- Do not claim Cloudflare deployment or Telegram delivery before a live check.

## Review Focus
- Regional short-link redirects must stay on approved Pinterest hosts.
- Primary structured video can reference the original pin rather than the shared repin: use the page's dedicated video-snippet, never recommendations.
- Unknown content length must still enforce upload size.
- A failed upload may have delivered already: no automatic resend.
- Concurrent webhook retries must be claimed atomically in SQL.

### Task 1: Pinterest extraction
**Files:** src/pinterest.js, src/errors.js, test/pinterest.test.js.
**Interfaces:** resolvePin(url, fetcher, signal) -> {id,url}; parseVideo(html,id) -> {url,width,height,duration}; getVideo(url,fetcher,signal) -> video.
- [x] Write tests for exact domains, redirect boundaries, JSON-LD primary video, exact-pin legacy data, no MP4 and recommendation isolation.
- [x] Run node --test test/pinterest.test.js and observe missing implementation.
- [x] Implement bounded redirects and primary-video extraction with explicit errors.
- [x] Run tests and commit.

### Task 2: Telegram delivery and webhook
**Files:** src/telegram.js, src/index.js, migrations/0001_updates.sql, test/worker.test.js.
**Interfaces:** sendVideo(env,chatId,video,fetcher,signal) streams multipart; handleRequest(request,env,fetcher) -> Response.
- [x] Write tests for authentication, owner access, SQL deduplication, failure states, byte preservation and upload limits.
- [x] Run node --test test/worker.test.js and observe missing implementation.
- [x] Implement streaming upload, total timeout and D1 claims/status transitions.
- [x] Run the whole suite and commit.

### Task 3: Deployment package
**Files:** package.json, wrangler.jsonc, scripts/setup-webhook.mjs, scripts/check-video.mjs, README.md, .gitignore, .github/workflows/check.yml.
- [x] Provide Russian setup instructions, exact Wrangler secret/binding commands and secure environment-only webhook setup.
- [x] Install Wrangler, run npm test and wrangler deploy --dry-run.
- [x] Run actual sample through project extraction and inspect downloaded MP4 using ffprobe.
- [x] Review, resolve material findings, commit and publish files to requested repository.

## Execution decisions
User instructed «всё создавай»: execute and publish directly to the specified repository without further design approvals. Cloudflare deployment is pending account configuration. Existing repository contains only the approved specification; there is no pre-existing test suite.

## Verification
18/18 tests passed; Wrangler dry-run passed. Real sample downloaded and inspected with ffprobe. Independent review findings fixed with failing-then-passing regressions. Publication is performed as the final implementation step; deployment remains pending credentials.
