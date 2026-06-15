---
layout: post
title: Encryption Rolling
series: "APFS Internals"
series_part: 23
categories: [file-systems, apfs]
tags: [apfs, encryption, rolling]
---

In our posts on [Keybags](/post/2022/12/21/APFS-Keybags), [Wrapped Keys](/post/2022/12/22/APFS-Wrapped-Keys), and [Decryption](/post/2022/12/26/APFS-Decryption), we covered the static encryption architecture of APFS: how keys are stored, unwrapped, and used to decrypt data. This post covers _encryption rolling_, the background process that encrypts, decrypts, or re-keys an entire volume's data while the system continues operating.

## Overview

Encryption rolling is triggered when a volume transitions between encryption states: from unencrypted to encrypted, from encrypted to unencrypted, or from one key to another. Because a volume may contain terabytes of data, this operation cannot complete in a single transaction. Instead, APFS maintains an `er_state_phys_t` object that tracks progress across transactions, allowing the operation to resume after crashes or reboots.

The encryption rolling state object is referenced by the `apfs_er_state_oid` field of the [Volume Superblock](/post/2022/12/13/APFS-Volume-Superblock).

## Phases

Encryption rolling proceeds through three phases, tracked in the `ersb_flags` field. The `er_phase_t` values below are not stored directly: they are shifted into bits 12-13 of `ersb_flags` (extract via `ERSB_FLAG_ER_PHASE_MASK` `0x3000` and `ERSB_FLAG_ER_PHASE_SHIFT` `12`), so `ER_PHASE_DATA_ROLL` (2) appears on disk as `0x2000`.

{: style="margin-left: 0"}
Phase | Value | Description
------|-------|------------
ER_PHASE_OMAP_ROLL | 1 | Rolling the volume's Object Map nodes
ER_PHASE_DATA_ROLL | 2 | Rolling file data extents
ER_PHASE_SNAP_ROLL | 3 | Rolling snapshot data

Each phase processes its objects in windows, encrypting or decrypting a chunk of data at a time (typically 1 MiB per window).

## er_state_phys_t

The on-disk encryption rolling state (version 2, 128 bytes total).

```cpp
#define ER_MAGIC 0x464C4142 // 'FLAB'

typedef struct er_state_phys_header {
    obj_phys_t ersb_o;     // 0x00
    uint32_t ersb_magic;   // 0x20
    uint32_t ersb_version; // 0x24
} er_state_phys_header_t;  // 0x28

typedef struct er_state_phys {
    er_state_phys_header_t ersb_header;        // 0x00
    uint64_t ersb_flags;                       // 0x28
    uint64_t ersb_snap_xid;                    // 0x30
    uint64_t ersb_current_fext_obj_id;         // 0x38
    uint64_t ersb_file_offset;                 // 0x40
    uint64_t ersb_progress;                    // 0x48
    uint64_t ersb_total_blk_to_encrypt;        // 0x50
    oid_t ersb_blockmap_oid;                   // 0x58
    uint64_t ersb_tidemark_obj_id;             // 0x60
    uint64_t ersb_recovery_extents_count;      // 0x68
    oid_t ersb_recovery_list_oid;              // 0x70
    uint64_t ersb_recovery_length;             // 0x78
} er_state_phys_t;                             // 0x80
```
- `ersb_header`: Object header with magic (`'FLAB'`) and version (1 or 2)
- `ersb_flags`: Operation type, phase, checksum block size, and status flags
- `ersb_snap_xid`: Transaction identifier of the snapshot used as the rolling baseline
- `ersb_current_fext_obj_id`: Object identifier of the file extent currently being processed
- `ersb_file_offset`: Byte offset within the current file
- `ersb_progress`: Number of blocks processed so far
- `ersb_total_blk_to_encrypt`: Total blocks that need processing
- `ersb_blockmap_oid`: Object identifier of the rolling block map
- `ersb_tidemark_obj_id`: Tracks the boundary between processed and unprocessed data
- `ersb_recovery_extents_count`: Number of recovery extents for crash recovery
- `ersb_recovery_list_oid`: Object identifier of the recovery extent list
- `ersb_recovery_length`: Total length of recovery data in blocks

## Encryption Rolling Flags

```cpp
#define ERSB_FLAG_ENCRYPTING       0x00000001
#define ERSB_FLAG_DECRYPTING       0x00000002
#define ERSB_FLAG_KEYROLLING       0x00000004
#define ERSB_FLAG_PAUSED           0x00000008
#define ERSB_FLAG_FAILED           0x00000010
#define ERSB_FLAG_CID_IS_TWEAK     0x00000020
#define ERSB_FLAG_CM_BLOCK_SIZE_MASK  0x00000F00
#define ERSB_FLAG_CM_BLOCK_SIZE_SHIFT 8
#define ERSB_FLAG_ER_PHASE_MASK    0x00003000
#define ERSB_FLAG_ER_PHASE_SHIFT   12
#define ERSB_FLAG_FROM_ONEKEY      0x00004000
```

The operation type is one of `ENCRYPTING`, `DECRYPTING`, or `KEYROLLING` (key rolling is not supported in the current implementation). The current phase is extracted from bits 12-13. The checksum block size (bits 8-11) encodes the hardware encryption block size used for integrity checks.

## Rolling Window Algorithm

The rolling process operates on a window of file extents at a time:

### Pre-Roll Phase
1. Enter a transaction.
2. Lock file extents for the current window.
3. For each extent, compute AES-XTS tweaks and read the unrolled data.
4. Compute SHA-256 checksums for each checksum-block-sized chunk and store truncated hashes in a recovery buffer.
5. Write recovery data to disk so the operation can resume after a crash.
6. Commit the transaction.

### Data Roll Phase
1. Encrypt (or decrypt) each extent's data in-place using XTS-AES.
2. Write the rolled data back to its physical location.
3. If a write fails, retry up to 30 times with a 1-second sleep between attempts. After exhausting retries, mark the operation as failed.

### Post-Roll Phase
1. Enter a new transaction.
2. Update the block map to record the new encryption state.
3. For decryption, update file extent records to remove the crypto association.
4. Delete recovery data.
5. Update progress counters.
6. Commit.

## Recovery Blocks

Recovery blocks store data needed for crash recovery during the data roll phase. If the system crashes after writing encrypted data but before committing the post-roll transaction, the recovery data allows the operation to be verified and resumed.

```cpp
typedef struct er_recovery_block_phys {
    obj_phys_t erb_o;       // 0x00
    uint64_t erb_offset;    // 0x20
    oid_t erb_next_oid;     // 0x28
    uint8_t erb_data[];     // 0x30
} er_recovery_block_phys_t;
```
- `erb_o`: The object's header
- `erb_offset`: Byte offset into the recovery data stream
- `erb_next_oid`: Object identifier of the next recovery block, or zero
- `erb_data`: Recovery data payload (checksums of the pre-roll data)

## General-Purpose Bitmaps

A _general-purpose bitmap_ tracks per-block rolling state, indicating which blocks have been processed and which remain.

```cpp
typedef struct gbitmap_phys {
    obj_phys_t bm_o;       // 0x00
    oid_t bm_tree_oid;     // 0x20
    uint64_t bm_bit_count; // 0x28
    uint64_t bm_flags;     // 0x30
} gbitmap_phys_t;          // 0x38
```
- `bm_o`: The object's header
- `bm_tree_oid`: Object identifier of the B-Tree storing bitmap blocks
- `bm_bit_count`: Total number of bits in the bitmap
- `bm_flags`: Reserved (zero)

The bitmap blocks themselves are stored as `gbitmap_block_phys_t` objects containing the raw bitmap data. Each bit represents one block in the volume; a set bit indicates the block has been rolled.

## Forensic Considerations

Encryption rolling state reveals important information:

- A non-zero `apfs_er_state_oid` in the Volume Superblock indicates an encryption transition was in progress (or interrupted).
- The `ersb_progress` and `ersb_total_blk_to_encrypt` fields reveal how far the operation had progressed.
- The `ERSB_FLAG_FAILED` or `ERSB_FLAG_PAUSED` flags indicate an interrupted or failed transition.
- During a partial roll, some blocks are encrypted and others are not. The general-purpose bitmap identifies which blocks have been processed, enabling correct decryption of mixed-state volumes.
- The `ERSB_FLAG_FROM_ONEKEY` flag indicates the volume was previously encrypted with a per-volume key, which affects tweak computation for unrolled blocks.

## Conclusion

Encryption rolling provides crash-safe, incremental encryption state transitions for APFS volumes. Its multi-phase design (OMAP, data, snapshots) ensures all volume data is processed, while recovery blocks and general-purpose bitmaps enable correct resumption after interruptions. Understanding this mechanism is essential for forensic analysis of volumes in transitional encryption states.
