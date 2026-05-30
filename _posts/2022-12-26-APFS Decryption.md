---
layout: post
title: Decryption
series: "APFS Internals"
series_part: 22
categories: [file-systems, apfs]
tags: [apfs, decryption, encryption]
---

Now that we know how to parse the [File System Tree](/post/2022/12/15/APFS-FSTrees), [analyze keybags](/post/2022/12/21/APFS-Keybags), and [unwrap decryption keys](/post/2022/12/22/APFS-Wrapped-Keys), it's time to put it all together and learn how to decrypt file system metadata and file data on encrypted volumes in APFS.

## Volume Encryption Modes

Before attempting decryption, verify the volume's encryption mode. Exactly one of these flags must be set in the `apfs_fs_flags` field of the [Volume Superblock](/post/2022/12/13/APFS-Volume-Superblock):

{: style="margin-left: 0"}
Flag | Value | Description
-----|-------|------------
APFS_FS_UNENCRYPTED | 0x01 | Volume is not encrypted
APFS_FS_ONEKEY | 0x08 | Single per-volume encryption key (software encryption)
APFS_FS_SCALEABLE_PFK | 0x100 | Per-file keys with separate crypto state records

If `APFS_FS_UNENCRYPTED` is set, no decryption is needed. If `APFS_FS_ONEKEY` is set, the single Volume Encryption Key (VEK) obtained from the [keybag](/post/2022/12/21/APFS-Keybags) is used for all data. If per-file keys are in use, each file has its own encryption state stored in `APFS_TYPE_CRYPTO_STATE` records in the File System Tree.

## Per-File Crypto State

On volumes with per-file encryption, each file's encryption state is stored in a `j_crypto_val_t` record:

```cpp
typedef struct j_crypto_val {
    uint32_t refcnt;                    // 0x00
    wrapped_crypto_state_t state;       // 0x04
} j_crypto_val_t;
```
- `refcnt`: Reference count (how many inodes share this crypto state)
- `state`: The wrapped encryption state including the protection class and wrapped key

The `wrapped_crypto_state_t` contains the file's protection class, key revision, OS version that created the key, and the actual wrapped key data. The `default_crypto_id` field in a file's `j_dstream_t` references this crypto state record.

For single-key volumes (`APFS_FS_ONEKEY`), the `crypto_id` in file extent records contains the AES-XTS tweak directly rather than referencing a crypto state record. The placeholder constant `CRYPTO_SW_ID` (4) is used for the `default_crypto_id` on these volumes.

## Tweaks

All encryption in APFS is based on the [XTS-AES-128](https://en.wikipedia.org/wiki/Disk_encryption_theory#XEX-based_tweaked-codebook_mode_with_ciphertext_stealing_(XTS)) cipher, which uses a 256-bit key and a 64-bit ["tweak"](https://en.wikipedia.org/wiki/Block_cipher#Tweakable_block_ciphers) value.  This _tweak_ value is position dependent.  It allows the same _plaintext_ to be encrypted and stored in different locations on disk and have drastically different _ciphertext_ while using the same AES key.  Every 512 bytes of encrypted data uses a tweak based on the container offset of the block's initial storage.  

Knowledge of the AES key alone is not always enough for successful decryption.  If the encrypted block is ever relocated on disk, the data is not guaranteed to be re-encrypted with a new tweak.  In these cases, the tweak can not be inferred based on the block's on-disk location, so we must learn the original tweak value used for encryption.  

## Identifying Encrypted Blocks

There are primarily two sets of data protected with the APFS _Volume Encryption Key_: [_File System Tree Nodes_](/post/2022/12/15/APFS-FSTrees) and [_File Extents_](/post/2022/12/19/APFS-Data-Streams).  As we've discussed, _File System Tree Nodes_ store the _File System Records_ that contain the file system's metadata, and _File Extents_ contain the bulk of the data stored in a file's _Data Streams_.

### Encrypted FS-Tree Nodes

A volume's _Object Map_ is never encrypted, but its referenced _virtual objects_ may be, as is the case with FS-Tree Nodes on encrypted volumes.

Let's revisit the value half of an _Object Map entry_.

```cpp
typedef struct omap_val {
  uint32_t ov_flags; // 0x00
  uint32_t ov_size;  // 0x04
  paddr_t ov_paddr;  // 0x08
} omap_val_t;        // 0x10
```

If the `ov_flags` bit-field member has the `OMAP_VAL_ENCRYPTED` flag set, then the virtual object located at `ov_paddr` is encrypted. These objects are never relocated without being re-encrypted, so the tweak of the first 512 bytes of data can be determined by the physical location of the data using the following logic, with the following tweak values incremented for each subsequent 512 bytes of data:

```cpp
uint64_t tweak0 = (ov_paddr * block_size) / 512;
```

### Encrypted Extents

Extent data can be relocated on disk and is not guaranteed to be re-encrypted.  Due to this, the initial tweak value is stored in the `crypto_id` field of the `j_file_extent_val_t` file system record:

```cpp
typedef struct j_file_extent_val {
  uint64_t len_and_flags;  // 0x00
  uint64_t phys_block_num; // 0x08
  uint64_t crypto_id;      // 0x10
} j_file_extent_val_t;     // 0x18
```

## Complete Decryption Chain

Putting the pieces from our previous posts together, here is the full chain for accessing data on a software-encrypted volume:

1. Locate the container keybag using the `nx_keylocker` field of the [NX Superblock](/post/2022/12/06/APFS-NX-Superblock).
2. Decrypt the container keybag using the container’s UUID concatenated with itself as a 256-bit XTS-AES-128 key.
3. Find the `KB_TAG_VOLUME_KEY` entry matching the volume’s UUID. This contains the wrapped VEK.
4. Find the `KB_TAG_VOLUME_UNLOCK_RECORDS` entry matching the volume’s UUID. This `prange_t` locates the volume keybag.
5. Decrypt the volume keybag using the volume’s UUID concatenated with itself.
6. Find the `KB_TAG_VOLUME_UNLOCK_RECORDS` entry matching the user’s UUID. This contains the [wrapped KEK](/post/2022/12/22/APFS-Wrapped-Keys).
7. Unwrap the KEK using the user’s password (via PBKDF2), then unwrap the VEK using the KEK (via RFC 3394).
8. Decrypt FS-Tree nodes using the VEK with position-based tweaks.
9. Decrypt file extents using the VEK with `crypto_id`-based tweaks.

## Secure Erasure

APFS keybags are encrypted using their owning UUID (container or volume). This enables _crypto-erasure_: destroying the UUID renders the keybag permanently unreadable, making all encrypted data inaccessible without needing to overwrite every block. For a volume, erasing the volume superblock destroys its UUID. For a container, all copies of the container superblock must be destroyed: both the checkpoint copies in the descriptor area and the copy at block zero.

## Conclusion

We’ve now discussed all of the information needed to access data on software-encrypted APFS volumes. This decryption requires the knowledge of the password of any user on the system or one of the various recovery keys. While APFS hardware encryption works in largely the same manner, the encryption also depends on keys that are stored within the specific security chip on a given system. There are currently no known methods of extracting these chip-specific keys; therefore, the data on hardware-encrypted devices must be decrypted at acquisition time on the device itself. The only software that I am aware of that is capable of this is [Cellebrite’s Digital Collector](https://cellebrite.com/en/digital-collector/).

_Full disclosure: I previously worked for Cellebrite and helped develop these capabilities. I do not directly profit from the sales of Digital Collector but felt it appropriate to disclose my association when linking to a commercial product. I am not trying to sell you anything. Unfortunately, I am also not at liberty to discuss the methodology used to facilitate this decryption._

