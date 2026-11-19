# Proofwork

Proofwork keeps a tax workpaper adjustment connected to its evidence and review history. This directory contains the deterministic review engine, the review queue and evidence drawer, and a runnable example with invented records. The hosted prototype shows the complete browser workflow.

- [Open the hosted prototype](https://proofwork-tax-jacob.zsw631123123.chatgpt.site/)
- [Watch the walkthrough](https://www.youtube.com/watch?v=Yv1f2pFyUZU)

## Run the browser demo or CLI

Run from this directory with Node.js 22.13 or later.

```sh
npm ci
npm test
npm run demo
npm run dev
```

Open the local URL printed by Vite. Select the repeated-scan finding, open its evidence, and record the proposed adjustment. The browser stores the review locally.

The [sample packet](examples/packet.ts) contains two scans of an 88-mile record. The detector compares normalized page text and verifies that both values contributed to the same return line. The example emits both source references and records an adjustment from **88 to 44** at the sample's illustrative per-mile rate of **0.50**. The original value remains in the adjustment record.

[Checks](lib/checks.ts) derive findings from supplied evidence. The [workflow](lib/workflow.ts) records actor, reason, original value, and revision, and invalidates earlier approvals when material changes occur. [Source location](lib/source-locator.ts) maps evidence back to a text span. [Browser demo logic](lib/public-demo.ts) applies and restores review changes using the same domain rules.

The listed values and rates are invented for software testing. The engine demonstrates review and audit behavior using a supplied calculation.
