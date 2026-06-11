---
layout: post
title: Volume Grafting
series: "APFS Internals"
series_part: 25
categories: [file-systems, apfs]
tags: [apfs, grafting, cryptex]
---

Volume grafting is a mechanism introduced in macOS 13 that mounts a disk image's APFS contents as a subdirectory of an existing volume. This is the technology behind _Cryptexes_, the cryptographically sealed, graftable disk images used for Rapid Security Responses and system extensions. This post covers the graft lifecycle, constraints, and on-disk metadata.

## Overview

A graft takes an APFS-formatted disk image file that resides on a host volume and mounts its file system tree under a designated directory on that same volume. To applications, the grafted content appears as ordinary files and directories within the host volume's namespace. Up to 255 grafts can be active on a single volume simultaneously.

The kernel builds a _blockmap LUT_ (lookup table) that maps logical block addresses within the graft image to physical blocks on the host volume's storage. This allows the grafted file system to be read using the same block I/O path as the host volume.

## Graft Constraints

- Maximum 255 grafts per volume
- The graft file must be a regular file with nonzero size
- The graft file must not have hard links (`nlink` must be less than 2)
- The graft file must not be compressed
- Grafts cannot be nested: the graft file must not reside inside another graft
- The graft directory must be an existing, non-deleted directory that is not already a graft point
- The host volume must not itself be a graft
- On encrypted volumes, the file must use protection class C or D; cloned files and empty files are rejected
- Volumes undergoing crypto transformation cannot graft (returns `ETXTBSY`, errno 26)

## Graft Extended Attributes

Three extended attributes on the graft file's inode record the J-object ID reservation:

{: style="margin-left: 0"}
Name | Size | Description
-----|------|------------
`com.apple.fs.graft-vol-uuid` | 16 bytes | UUID of the host volume at graft time
`com.apple.fs.graft-jobj-id-base` | 8 bytes | Base (start) of the reserved J-object ID range
`com.apple.fs.graft-jobj-id-len` | 8 bytes | Length (count) of the reserved J-object ID range

These attributes are file-system-owned (`XATTR_FILE_SYSTEM_OWNED`) and persist after ungraft, allowing subsequent grafts of the same file to reclaim the same ID range without conflicts.

## Graft Lifecycle

### Phase 1: Validation

The kernel verifies that all constraints are met: the file exists, is not compressed, has no hard links, the directory is valid, and the volume has capacity for another graft.

### Phase 2: Blockmap LUT Construction

The kernel iterates all data extents of the graft file and builds an in-memory B-Tree (subtype `OBJECT_TYPE_GRAFT_BLOCKMAP_LUT_TREE`) that maps logical blocks within the image to physical blocks on the host volume. If the file is a clone of an already-grafted file, the existing blockmap is shared.

### Phase 3: Encryption

On encrypted volumes, the graft file's encryption key is unwrapped and retained for later I/O translation.

### Phase 4: Container and Volume Mount

The APFS container embedded in the graft image is mounted using the blockmap LUT for I/O translation. The first volume within the grafted container is then mounted.

### Phase 5: Metadata LUT Enhancement

The blockmap is augmented with metadata block mappings (container superblock, checkpoint areas, space manager, object maps, B-Tree nodes). Metadata blocks are distinguished from data blocks by having bit 31 set in the LUT key.

### Phase 6: Image4 Authentication

For sealed graft images (Cryptexes), the volume's root hash is verified against an Image4 payload and manifest. Authentication volume types include:

{: style="margin-left: 0"}
Type | Name | Description
-----|------|------------
4 | RSR Graft | Rapid Security Response (authentication always required)
5 | Strict Graft | Authentication failure is fatal (kernel panic)

### Phase 7: J-Object ID Range Reservation

A range of object identifiers is reserved from the host volume's ID space for the grafted content. This ensures grafted inodes do not collide with host volume inodes. The reservation is persisted in the graft extended attributes.

### Phase 8: State Registration

The graft state is registered, a synthetic device ID is generated, and grafted file-system vnodes are loaded. An IOKit `AppleAPFSGraft` service node is published.

## Ungraft

The ungraft operation reverses the graft:

1. Remove graft state and decrement the volume's graft count
2. Wait for all concurrent readers to drain
3. Revoke vnodes belonging to the graft
4. Detach the IOKit service node
5. Unmount the grafted volume and container
6. Clear graft-related inode flags on the directory and file
7. Release crypto state if present

The ungraft ioctl supports flags for ungrafting all grafts on a volume (bit 0) and forcing ungraft even when vnodes are in use (bit 1).

## Forensic Considerations

- The graft extended attributes (`com.apple.fs.graft-*`) on a file indicate it was used as a graft image, even if no graft is currently active.
- The `graft-vol-uuid` must match the current volume UUID, providing a way to verify the graft's provenance.
- The reserved J-object ID range reveals which inode numbers belong to grafted content.
- On sealed system volumes, grafts (Cryptexes) provide the mechanism for Rapid Security Responses: security patches can be applied without modifying the sealed system volume itself.
- The blockmap LUT is memory-only; it is not persisted on disk. Forensic analysis of grafted content requires parsing the graft image file's extents to reconstruct the logical-to-physical mapping.

## Conclusion

Volume grafting extends APFS's capabilities by allowing sealed disk images to be mounted as subdirectories. Combined with Image4 authentication, this provides a secure mechanism for distributing system extensions and security updates (Cryptexes) without breaking the sealed system volume's integrity guarantees.
