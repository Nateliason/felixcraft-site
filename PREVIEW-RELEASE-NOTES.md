# FelixCraft editorial redesign — review preview

Base: 99aa92324c14459d17dd9d628433f240413e7b5f. Feature branch only; do not merge without production approval.

## What changed
- Homepage: original pixel avatar retained; cream, ink, and vermilion editorial design; practical workflows and tools positioning.
- Three source-backed starter articles, visibly labeled untested, with references, prompts, and human review checkpoints.
- Brief builder and category filters run entirely in the browser, with no AI call, email collection, or backend.
- Original homepage/playbook retained verbatim at `/how-to-hire-an-ai.html`; homepage `#guide` routes visitors there.
- Existing `/dashboard`, `/crypto-claim.html`, delivery page, downloads, payment APIs, cron, and token redirect preserved. No ClawMart changes.
- Existing Google Analytics measurement ID G-M0W5XXDYX0 retained, one loader/config per page. Preview traffic may appear in GA; exclude preview hostnames in reporting. No new custom events or form-input tracking.

## Preview-only safeguards
The new HTML pages include `noindex,nofollow`, robots.txt blocks all crawlers, and the additive global X-Robots-Tag header covers legacy routes too. These MUST be removed/replaced deliberately for a production release. Do not copy this preview branch to production unchanged.

## Production decision checklist
1. Review positioning, tutorials, and branding. Tutorials are starter drafts, not tested results.
2. Validate workflows before changing their status; keep source references and limitations current.
3. Confirm original playbook and purchase/customer support wording remain valid before promoting it.
4. Approve route plan: preserve homepage #guide; retain all legacy routes; original playbook has moved from homepage to a dedicated page. No backend paths change.
5. Remove preview banner/noindex metadata/global header; restore robots exclusion for `/dl/` and existing delivery route; add a sitemap containing only intended public editorial URLs.
6. Review privacy/analytics notices and reporting filters for the live experience.
7. Add unique social preview image; verify production canonical URLs, headings, structured data, internal links, and mobile layouts.
8. Explicitly authorize release, test an appropriate production build, then promote. No production deploy was requested or performed here.

No pricing, testimonials, audience figures, or performance results were invented. No new paid service, account, integration, or credential was created.

## Verification commands
- `python scripts/check-preview.py` — source-level links, GA uniqueness, structured JSON, preview indexing guards, byte-identical legacy pages and unchanged backend config.
- `node scripts/test-ui.cjs` — stub-DOM interaction tests (not a browser test): category filters, repeat generation, copying, menu open/close.
- `/preview-mobile.html` is a preview-only 390px iframe harness for actual responsive rendering QA when the browser does not expose viewport resizing. Remove it before a production release.
