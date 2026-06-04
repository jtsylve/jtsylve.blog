---
layout: post
title: EFI Jumpstart
series: "APFS Internals"
series_part: 11
categories: [file-systems, apfs]
tags: [apfs, efi, boot]
---

APFS containers include an embedded EFI driver that allows UEFI firmware to boot from APFS partitions without requiring a built-in APFS driver. This post covers the `nx_efi_jumpstart_t` structure and the boot procedure that uses it.

## Overview

The EFI jumpstart mechanism is intentionally simple. The driver can be located by reading a few data structures starting from physical block zero, without any B-Tree traversal or complex APFS parsing. This minimal dependency means that UEFI firmware (or virtualization software) can load the APFS driver with only basic block-read capability.

The `nx_efi_jumpstart` field of the [NX Superblock](/post/2022/12/06/APFS-NX-Superblock) stores the physical block address of the jumpstart structure. This field is written during container creation and is not used by the kernel APFS driver during normal operation.

## Boot Procedure

To boot from an APFS partition using the embedded EFI driver:

1. Read physical block zero (the container superblock). Verify the Fletcher-64 checksum and confirm `nx_magic` equals `NX_MAGIC` (`'BSXN'`).

2. Read the physical block at the address in `nx_efi_jumpstart`.

3. Verify `nej_magic` equals `NX_EFI_JUMPSTART_MAGIC` (`'RDSJ'`), verify the Fletcher-64 checksum, and confirm `nej_version` is 1.

4. Allocate a contiguous memory buffer of at least `nej_efi_file_len` bytes.

5. Read the `nej_num_extents` extent records from `nej_rec_extents` and load each extent's blocks sequentially into the memory buffer.

6. Execute the loaded EFI driver.

## nx_efi_jumpstart_t

```cpp
#define NX_EFI_JUMPSTART_MAGIC 'RDSJ'
#define NX_EFI_JUMPSTART_VERSION 1

typedef struct nx_efi_jumpstart {
    obj_phys_t nej_o;             // 0x00
    uint32_t nej_magic;           // 0x20
    uint32_t nej_version;         // 0x24
    uint32_t nej_efi_file_len;    // 0x28
    uint32_t nej_num_extents;     // 0x2C
    uint64_t nej_reserved[16];    // 0x30
    prange_t nej_rec_extents[];   // 0xB0
} nx_efi_jumpstart_t;
```
- `nej_o`: The object header (type `OBJECT_TYPE_EFI_JUMPSTART`, physical)
- `nej_magic`: Must equal `NX_EFI_JUMPSTART_MAGIC` (`'RDSJ'`, on-disk bytes `4A 53 44 52`)
- `nej_version`: Must equal 1
- `nej_efi_file_len`: The total size of the embedded EFI driver in bytes
- `nej_num_extents`: The number of physical extent records that follow
- `nej_reserved`: Reserved (128 bytes, set to zero)
- `nej_rec_extents`: A variable-length array of `prange_t` records describing where the EFI driver blocks are stored on disk

Each `prange_t` in the extent array specifies a starting physical address and a block count:

```cpp
typedef struct prange {
    paddr_t pr_start_paddr; // 0x00
    uint64_t pr_block_count; // 0x08
} prange_t;                  // 0x10
```

The extents must be read sequentially and concatenated to assemble the complete driver image.

## GPT Partition Type

APFS partitions are identified in the GUID Partition Table by the following type UUID:

```
7C3457EF-0000-11AA-AA11-00306543ECAC
```

UEFI firmware uses this UUID to identify partitions that may contain an APFS container with an embedded EFI driver.

## Forensic Considerations

The EFI jumpstart structure is useful for forensic validation:

- Its presence and validity confirm that the partition was formatted as APFS (as opposed to being partially overwritten).
- The driver extents reference physical blocks that should be within the container's bounds. Out-of-range addresses indicate corruption.
- The jumpstart structure is independent of checkpoints. Since it is only written during container creation, it provides a stable reference point that survives checkpoint-level corruption.

## Conclusion

The EFI jumpstart mechanism provides a minimal, self-contained boot path for APFS containers. Its simplicity (a single physical object with direct extent references) ensures that UEFI firmware can load the APFS driver without implementing any of the complex B-Tree or checkpoint logic that the rest of APFS requires.
