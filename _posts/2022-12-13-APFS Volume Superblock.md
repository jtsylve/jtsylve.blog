---
layout: post
title: Volume Superblock Objects
series: "APFS Internals"
series_part: 9
categories: [file-systems, apfs]
tags: [apfs, volumes, superblock]
---

The _Volume Superblock_ is a data structure containing key information about an individual APFS volume. This post covers locating the Volume Superblock on disk and describes the on-disk format’s fields.

## Locating Volume Superblocks

Every volume in APFS has a _Volume Superblock Object_ that serves as the root source of on-disk information about the volume and its file system.  These are _virtual objects_ whose references are managed by the [Container’s _Object Map_](/post/2022/12/12/APFS-OMAP).  Once you understand how to parse an Object Map, identifying the on-disk location of these superblocks is simple.

1. Read the `nx_max_file_systems` field of the [_NX Superblock Object_](/post/2022/12/06/APFS-NX-Superblock) to determine the maximum number of volumes that the container can support.

2. Enumerate the `nx_fs_oid` array looking for the non-zero _virtual object identifiers_ of each Volume Superblock Object. The identifiers may not always be stored contiguously in the array, but all array entries after `nx_max_file_systems` will always be zero.

3. Query the Container's Object Map to locate the physical address of each Volume Superblock. 

## On-Disk Structures

Volume Superblock Objects are stored on disk as `apfs_superblock_t` structures.  We will discuss many of these structure fields in detail throughout this series.  Below is a short description of each.

```cpp
#define APFS_MAGIC 0x41504342 // APSB
#define APFS_MAX_HIST 8
#define APFS_VOLNAME_LEN 256

// Volume Superblock
typedef struct apfs_superblock {
    obj_phys_t apfs_o;                                  // 0x00
    uint32_t apfs_magic;                                // 0x20
    uint32_t apfs_fs_index;                             // 0x24
    uint64_t apfs_features;                             // 0x28
    uint64_t apfs_readonly_compatible_features;         // 0x30
    uint64_t apfs_incompatible_features;                // 0x38
    uint64_t apfs_unmount_time;                         // 0x40
    uint64_t apfs_fs_reserve_block_count;               // 0x48
    uint64_t apfs_fs_quota_block_count;                 // 0x50
    uint64_t apfs_fs_alloc_count;                       // 0x58
    wrapped_meta_crypto_state_t apfs_meta_crypto;       // 0x60
    uint32_t apfs_root_tree_type;                       // 0x74
    uint32_t apfs_extentref_tree_type;                  // 0x78
    uint32_t apfs_snap_meta_tree_type;                  // 0x7C
    oid_t apfs_omap_oid;                                // 0x80
    oid_t apfs_root_tree_oid;                           // 0x88
    oid_t apfs_extentref_tree_oid;                      // 0x90
    oid_t apfs_snap_meta_tree_oid;                      // 0x98
    xid_t apfs_revert_to_xid;                           // 0xA0
    oid_t apfs_revert_to_sblock_oid;                    // 0xA8
    uint64_t apfs_next_obj_id;                          // 0xB0
    uint64_t apfs_num_files;                            // 0xB8
    uint64_t apfs_num_directories;                      // 0xC0
    uint64_t apfs_num_symlinks;                         // 0xC8
    uint64_t apfs_num_other_fsobjects;                  // 0xD0
    uint64_t apfs_num_snapshots;                        // 0xD8
    uint64_t apfs_total_blocks_alloced;                 // 0xE0
    uint64_t apfs_total_blocks_freed;                   // 0xE8
    uuid_t apfs_vol_uuid;                               // 0xF0
    uint64_t apfs_last_mod_time;                        // 0x100
    uint64_t apfs_fs_flags;                             // 0x108
    apfs_modified_by_t apfs_formatted_by;               // 0x110
    apfs_modified_by_t apfs_modified_by[APFS_MAX_HIST]; // 0x140
    uint8_t apfs_volname[APFS_VOLNAME_LEN];             // 0x2C0
    uint32_t apfs_next_doc_id;                          // 0x3C0
    uint16_t apfs_role;                                 // 0x3C4
    uint16_t reserved;                                  // 0x3C6
    xid_t apfs_root_to_xid;                             // 0x3C8
    oid_t apfs_er_state_oid;                            // 0x3D0
    uint64_t apfs_cloneinfo_id_epoch;                   // 0x3D8
    uint64_t apfs_cloneinfo_xid;                        // 0x3E0
    oid_t apfs_snap_meta_ext_oid;                       // 0x3E8
    uuid_t apfs_volume_group_id;                        // 0x3F0
    oid_t apfs_integrity_meta_oid;                      // 0x400
    oid_t apfs_fext_tree_oid;                           // 0x408
    uint32_t apfs_fext_tree_type;                       // 0x410
    uint32_t reserved_type;                             // 0x414
    oid_t reserved_oid;                                 // 0x418
} apfs_superblock_t;                                    // 0x420
```

- `apfs_o`: The object header
- `apfs_magic`: Magic value (always `APFS_MAGIC`)
- `apfs_fs_index`: The index of the object identifier for this volume's file system in the container's array of file systems
- `apfs_features`: A bit-field of the optional features being used by this volume
- `apfs_readonly_compatible_features`: A bit-field of the read-only compatible features being used by this volume. (_none currently defined_)
- `apfs_incompatible_features`: A bit-field of the backward-incompatible features being used by this volume
- `apfs_unmount_time`: The time that this volume was last unmounted
- `apfs_fs_reserve_block_count`: The number of blocks that have been reserved for this volume to allocate
- `apfs_fs_quota_block_count`: The maximum number of blocks that this volume can allocate (or zero if no limit)
- `apfs_fs_alloc_count`: The number of blocks currently allocated for this volume's file system
- `apfs_meta_crypto`: Information about the key used to encrypt metadata for this volume
- `apfs_root_tree_type`: The type of the root file-system tree
- `apfs_extentref_tree_type`: The type of the extent-reference tree
- `apfs_snap_meta_tree_type`: The type of the snapshot metadata tree
- `apfs_omap_oid`: The physical object identifier of the volume's object map
- `apfs_root_tree_oid`: The virtual object identifier of the root file-system tree
- `apfs_extentref_tree_oid`: The physical object identifier of the extent-reference tree
- `apfs_snap_meta_tree_oid`: The physical object identifier of the snapshot metadata tree
- `apfs_revert_to_xid`: The transaction identifier of a snapshot that the volume will revert to (or zero if not reverting)
- `apfs_revert_to_sblock_oid`: The physical object identifier of a volume superblock that the volume will revert to (or zero if not reverting)
- `apfs_next_obj_id`: The next identifier that will be assigned to a file-system object in this volume
- `apfs_num_files`: The number of regular files in this volume
- `apfs_num_directories`: The number of directories in this volume
- `apfs_num_symlinks`: The number of symbolic links in this volume
- `apfs_num_other_fsobjects`: The number of other files in this volume
- `apfs_num_snapshots`: The number of snapshots in this volume
- `apfs_total_blocks_alloced`: The total number of blocks that have been allocated by this volume
- `apfs_total_blocks_freed`: The total number of blocks that have been freed by this volume
- `apfs_vol_uuid`: The universally unique identifier for this volume
- `apfs_last_mod_time`: The time that this volume was last modified
- `apfs_fs_flags`: The volume's flags
- `apfs_formatted_by`: Information about the software that created this volume
- `apfs_modified_by`: Information about the software that has modified this volume
- `apfs_volname`: The name of the volume, represented as a null-terminated UTF-8 string
- `apfs_next_doc_id`: The next document identifier that will be assigned
- `apfs_role`: The role of this volume within the container
- `reserved`: _reserved_
- `apfs_root_to_xid`: The transaction identifier of the snapshot to root from, or zero to root normally
- `apfs_er_state_oid`: The object id of the encryption rolling state (or zero if no encryption change is in progress)
- `apfs_cloneinfo_id_epoch`: The largest object identifier used by this volume at the time INODE_WAS_EVER_CLONED started storing valid information
- `apfs_cloneinfo_xid`: A transaction identifier used with `apfs_cloneinfo_id_epoch`
- `apfs_snap_meta_ext_oid`: The virtual object identifier of the extended snapshot metadata object
- `apfs_volume_group_id`: The volume group the volume belongs to (or null UUID if not part of a volume group)
- `apfs_integrity_meta_oid`: The virtual object identifier of the integrity metadata object
- `apfs_fext_tree_oid`: The virtual object identifier of the file extent tree
- `apfs_fext_tree_type`: The type of the file extent tree
- `reserved_type`: _reserved_
- `reserved_oid`: _reserved_

#### Optional Feature Flags

_Optional Feature Flags_ indicate that the volume uses newer features that older APFS implementations may not support but should be backward compatible with older standards. Implementations that do not support these features should still be able to mount the volume read/write without problems. These bit-flags are stored in the `apfs_features` field of the Volume Superblock.

{: style="margin-left: 0"}
Name | Value | Description
---- | ----- | -----------
APFS_FEATURE_DEFRAG_PRERELEASE | 0x00000001 | _reserved_
APFS_FEATURE_HARDLINK_MAP_RECORDS | 0x00000002 | The volume has hardlink map records
APFS_FEATURE_DEFRAG | 0x00000004 | The volume supports defragmentation
APFS_FEATURE_STRICTATIME | 0x00000008 | This volume updates file access times every time the file is read
APFS_FEATURE_VOLGRP_SYSTEM_INO_SPACE | 0x00000010 | This volume supports mounting a system and data volume as a single user-visible volume

#### Incompatible Volume Feature Flags

_Incompatible Volume Feature Flags_ indicate that the volume uses newer features that may not be supported by older APFS implementations and are not fully backward compatible with older standards. Implementations not supporting these features will likely have problems mounting the volume and are encouraged not to do so. These bit-flags are stored in the `apfs_incompatible_features` field of the Volume Superblock.

{: style="margin-left: 0"}
Name | Value | Description
---- | ----- | -----------
APFS_INCOMPAT_CASE_INSENSITIVE | 0x00000001 | Filenames on this volume are case insensitive
APFS_INCOMPAT_DATALESS_SNAPS | 0x00000002 | At least one snapshot with no data exists for this volume
APFS_INCOMPAT_ENC_ROLLED | 0x00000004 | This volumeʼs encryption has changed keys at least once
APFS_INCOMPAT_NORMALIZATION_INSENSITIVE | 0x00000008 | Filenames on this volume are normalization insensitive
APFS_INCOMPAT_INCOMPLETE_RESTORE | 0x00000010 | This volume is being restored, or a restore operation to this volume was uncleanly aborted
APFS_INCOMPAT_SEALED_VOLUME | 0x00000020 | This volume can't be modified
APFS_INCOMPAT_RESERVED_40 | 0x00000040 | _reserved_

#### Volume Flags

_Volume Flags_ are used to indicate additional information about the volume's status. This bit-field is stored in the `apfs_flags` field of the Volume Superblock.

{: style="margin-left: 0"}
Name | Value | Description
---- | ----- | -----------
APFS_FS_UNENCRYPTED | 0x00000001 | The volume is not encrypted
APFS_FS_RESERVED_2 | 0x00000002 | _reserved_
APFS_FS_RESERVED_4 | 0x00000004 | _reserved_
APFS_FS_ONEKEY | 0x00000008 | Files on the volume are all encrypted using the volume encryption key (VEK)
APFS_FS_SPILLEDOVER | 0x00000010 | The volume has run out of allocated space on the solid-state drive
APFS_FS_RUN_SPILLOVER_CLEANER | 0x00000020 | The volume has spilled over and the spillover cleaner must be run
APFS_FS_ALWAYS_CHECK_EXTENTREF | 0x00000040 | The volume's extent reference tree is always consulted when deciding whether to overwrite an extent
APFS_FS_RESERVED_80 | 0x00000080 | _reserved_
APFS_FS_RESERVED_100 | 0x00000100 | _reserved_

#### Volume Roles

In most instances, an APFS Volume is marked as having a defined _role_. The presence of these roles is context specific, depending on whether the device being analyzed is running macOS or iOS. A Volume can only have a single defined role whose value is stored in the `apfs_role` member of the Volume Superblock.

{: style="margin-left: 0"}
Name | Value | Description
---- | ----- | -----------
APFS_VOL_ROLE_NONE | 0x0000 | The volume has no defined role
APFS_VOL_ROLE_SYSTEM | 0x0001 | The volume contains a root directory for the system
APFS_VOL_ROLE_USER | 0x0002 | The volume contains users' home directories
APFS_VOL_ROLE_RECOVERY | 0x0004 | The volume contains a recovery system
APFS_VOL_ROLE_VM | 0x0008 | The volume is used as swap space for virtual memory
APFS_VOL_ROLE_PREBOOT | 0x0010 | The volume contains files needed to boot from an encrypted volume
APFS_VOL_ROLE_INSTALLER | 0x0020 | The volume is used by the OS installer
APFS_VOL_ROLE_DATA | 0x0040 | The volume contains mutable data
APFS_VOL_ROLE_BASEBAND | 0x0080 | The volume is used by the radio firmware
APFS_VOL_ROLE_UPDATE | 0x00C0 | The volume is used by the software update mechanism
APFS_VOL_ROLE_XART | 0x0100 | The volume is used to manage OS access to secure user data
APFS_VOL_ROLE_HARDWARE | 0x0140 | The volume is used for firmware data
APFS_VOL_ROLE_BACKUP | 0x0180 | The volume is used by Time Machine to store backups
APFS_VOL_ROLE_RESERVED_7 | 0x01C0 | _reserved_
APFS_VOL_ROLE_RESERVED_8 | 0x0200 | _reserved_
APFS_VOL_ROLE_ENTERPRISE | 0x0240 | This volume is used to store enterprise-managed data
APFS_VOL_ROLE_RESERVED_10 | 0x0280 | _reserved_
APFS_VOL_ROLE_PRELOGIN | 0x02C0 | This volume is used to store system data used before login

#### apfs_modified_by_t

Volume Superblocks store record-keeping information about the tool used to create them in the `apfs_formatted_by` field.  In this case, the id field of the `apfs_modified_by_t` structure will give the name and version number of the userland program used to create the volume.

These `apfs_modified_by_t` structures are also used to keep a history of the `apfs.kext` versions used for the last eight times the volume was mounted read/write.  These are stored in the `apfs_modified_by` array field.


```cpp
#define APFS_MODIFIED_NAMELEN 32

// Information about a program that modified the volume.
typedef struct apfs_modified_by {
    uint8_t id[APFS_MODIFIED_NAMELEN]; // 0x00
    uint64_t timestamp;                // 0x20
    xid_t last_xid;                    // 0x28
} apfs_modified_by_t;                  // 0x30
```

- `id`: A string that identifies the program and its version
- `timestamp`: The time that the program last modified this volume
- `last_xid`: The transaction identifier of the last transaction committed by this program

## Conclusion

Locating and analyzing Volume Superblocks are essential early steps in being able to parse the contents of their file systems.  Our next post will discuss the volume’s File System Tree, a specialized B-Tree that stores the bulk of the file systems’ metadata objects.

