---
layout: post
title: Revisiting the APFS Series
categories: [meta]
tags: [apfs]
---

Back in 2022 I started the [APFS Advent Challenge](/post/2022/11/27/APFS-Advent-Challenge-2022): a daily run of posts dissecting the on-disk internals of Apple's file system. Nearly four years later, both APFS and our collective understanding of it have moved on. So I've gone back through the entire series, brought every post up to date, and over the next two weeks I'll be adding new parts to fill in the gaps.

## What's changed since 2022

APFS is not a frozen target. It has continued to evolve across macOS releases, picking up new on-disk features and quietly refining old ones. The structures I documented in December 2022 were accurate then, but a lot has shifted underneath them since.

My own approach has changed too. The original posts were written largely day-by-day, under the self-imposed pressure of an advent calendar. Since then I've built far better tooling for this kind of work, and I now validate each structure directly against the current implementation rather than against memory and notes. That has let me correct a few details, sharpen explanations that were fuzzier than I'd like, and add depth in places where the original posts only scratched the surface.

## Living references, not snapshots

The most important change is one of intent. I want this series to be something you can actually rely on, not a museum piece dated December 2022.

So rather than leaving the original posts untouched and bolting corrections onto the end, I've revised them in place. Each one now reflects current APFS instead of a four-year-old snapshot. Posts that were updated carry an "Updated" date in their byline so you can see at a glance what has been touched. The permalinks haven't moved, so any links or bookmarks you already have will keep working.

## New parts, coming over the next two weeks

The original run also left real gaps. Some of the container's internal machinery never got covered, and several features either postdate the 2022 series or simply didn't make the cut when I ran out of December. Over the next two weeks I'll be publishing new entries to round the series out:

- **Space Manager**: how APFS tracks free and allocated blocks
- **The Reaper**: crash-safe, multi-transaction garbage collection
- **EFI Jumpstart**: booting from an APFS container
- **Hard Links and Siblings**: the sibling-link records behind hard links
- **Transparent Compression (DECMPFS)**: inline and resource-fork compression
- **Clonegroups**: tracking copy-on-write clones
- **Encryption Rolling**: re-encrypting a volume in place
- **Volume Grafting**: overlaying volumes for system updates
- **Speculative Telemetry**: tracking speculatively downloaded content

That brings the series to 27 parts spanning the container layer, B-Trees, the volume and file-system layer, integrity and encryption, and APFS's more advanced features.

## Read the series

The [series index](/apfs/) lays out the full planned structure. Parts that haven't published yet are marked "Coming Soon" and will light up as they go live over the coming days. If you read the series back in 2022, it's worth a second look. If you're coming to it fresh, there's never been a better time.
