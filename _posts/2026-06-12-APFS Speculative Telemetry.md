---
layout: post
title: Speculative Telemetry
series: "APFS Internals"
series_part: 27
categories: [file-systems, apfs]
tags: [apfs, telemetry, cloud]
last_modified_at: 2026-06-15
---

Speculative telemetry is an APFS feature that tracks the lifecycle of speculatively downloaded files: content fetched to local storage before the user explicitly requests it, such as files prefetched by iCloud or the App Store. This post covers the on-disk structures and state machine that enable this tracking.

## Overview

On eligible volumes (Data, Enterprise, or User role), APFS records residency state transitions for speculatively downloaded files: when they are materialized (downloaded), accessed, evicted (data removed but inode retained), or purged (fully deleted). This information helps the system optimize its prefetch decisions by understanding which speculative downloads were actually useful.

Tracking is active only when bit 0 of the `spec_telem_enablement` boot-arg (or sysctl) is set, and only on volumes that are not snapshot-mounted.

## Inode Flags

Two flags in `j_inode_val_t.internal_flags` control participation:

```cpp
#define INODE_MAINTAIN_SPECULATIVE_TELEMETRY 0x20000000  // bit 29
#define INODE_SPECULATIVE_TELEMETRY_ACTIVE   0x40000000  // bit 30
```

`INODE_MAINTAIN_SPECULATIVE_TELEMETRY` is inherited from parent directories (part of the inherited flags mask). It marks an inode or directory as eligible for telemetry tracking. `INODE_SPECULATIVE_TELEMETRY_ACTIVE` is set when the inode qualifies for active tracking and causes creation or update of the telemetry extended attribute.

## Extended Attribute

Telemetry data is stored in a file-system-owned, embedded extended attribute:

```cpp
#define SPECULATIVE_TELEMETRY_EA_NAME "com.apple.system.fs.speculative_telemetry"

typedef struct spec_telemetry_xattr {
    uint8_t version;      // 0x00 (must be 0)
    uint8_t use_state;    // 0x01
    uint16_t flags;       // 0x02
    uint64_t timestamp;   // 0x04
} spec_telemetry_xattr_t; // 0x0C (12 bytes)
```
- `version`: Must be 0 (future versions are rejected)
- `use_state`: The current residency/usage state
- `flags`: Bit 0 = dirty (state changed but fsevent not yet sent), bits 2-5 = residency reason
- `timestamp`: APFS timestamp (nanoseconds since epoch) of the last state transition

This attribute is always 12 bytes and cannot be set from userland.

## Use States

{: style="margin-left: 0"}
Value | Name | Description
------|------|------------
0 | None | No telemetry state recorded
1 | Materialized | File data was downloaded to local storage
2 | Evicted | File data was removed from local storage (inode remains)
3 | Purged | File was fully purged (deleted)
4 | Accessed | File data was accessed by a user or process
5 | Downloaded | File was explicitly downloaded (not speculative)
6 | Reserved | No-op (no state change)

## Residency Reasons

The `flags` field (bits 2-5) encodes why the file was speculatively downloaded. This allows the system to distinguish between different prefetch strategies and measure their effectiveness. APFS validates the range (0-6) but does not interpret the value; the semantic meanings are defined by the FileProvider framework:

{: style="margin-left: 0"}
Value | Name | Description
------|------|------------
1 | `recents` | Appeared in the user's recent-documents set
2 | `speculativeUpdates` | Background prefetch by the speculative-downloads subsystem
3 | `createdLocallyOrUserRequestedOnOlderBuild` | Legacy ambiguous reason from older builds
4 | `providerRequested` | The cloud provider extension requested materialization
5 | `createdLocally` | Created on this device (not downloaded)
6 | `userRequested` | The user explicitly triggered the download

## Lifecycle

1. **Eligibility**: An inode qualifies for telemetry if it is a regular file or directory, `INODE_MAINTAIN_SPECULATIVE_TELEMETRY` is set, the volume has an eligible role, and `spec_telem_enablement` bit 0 is set.

2. **Creation**: When a qualifying inode is created in a tracked directory, `INODE_SPECULATIVE_TELEMETRY_ACTIVE` is set.

3. **Materialization**: When speculative content is downloaded, the extended attribute is created with `use_state = 1` (Materialized) and the current timestamp.

4. **Access**: When the file is read by a user or process, the state transitions to `4` (Accessed). This is the key metric: speculative downloads that are accessed were useful.

5. **Eviction**: When the system reclaims space by removing the file's data (while keeping the inode), the state transitions to `2` (Evicted).

6. **Purge**: When the file is fully deleted, the state transitions to `3` (Purged).

7. **Event Reporting**: When the telemetry state has changed but the corresponding event has not yet been reported, the dirty bit (`SPEC_TELEM_FLAG_DIRTY`, bit 0 of `flags`) is set. It is cleared before applying the next state change.

## Directory Integration

For directories with `INODE_MAINTAIN_DIR_STATS`, telemetry participation is tracked at the directory level through the `telemetry_count` field of the expanded directory-statistics record (`j_dir_stats_expanded_val_t`), updated during reconciliation. This enables aggregate reporting of speculative download effectiveness per directory hierarchy. (Note that `0x100` in the directory-statistics flag set is `DIR_STATS_INITIALIZED`, which is unrelated to telemetry.)

## Inode Extended Fields

Two legacy extended field types support telemetry:

{: style="margin-left: 0"}
Type | Value | Description
-----|-------|------------
INO_EXT_TYPE_SPEC_TELEMETRY_STATE | 20 | Legacy 2-byte field (read and immediately removed; superseded by the extended attribute)
INO_EXT_TYPE_SPEC_TELEMETRY_TRIGGER | 22 | 8-byte trigger information recorded when a purgeable file is removed after being accessed

## Forensic Considerations

- The `com.apple.system.fs.speculative_telemetry` extended attribute reveals which files were speculatively downloaded and whether they were ever accessed.
- The timestamp field provides precise timing of state transitions.
- The residency reason identifies the prefetch strategy that triggered the download.
- Files in the "Materialized" state (never accessed) represent wasted bandwidth and storage.
- The `INODE_MAINTAIN_SPECULATIVE_TELEMETRY` flag on directories identifies which directory hierarchies are managed by cloud sync services.

## Conclusion

Speculative telemetry gives APFS visibility into the effectiveness of speculative downloads. By tracking the complete lifecycle from materialization through access or eviction, the system can make informed decisions about which content to prefetch. For forensic analysis, these records reveal cloud sync activity, file access patterns, and storage management decisions.
