---
layout: post
title: Keybags
series: "APFS Internals"
series_part: 14
categories: [file-systems, apfs]
tags: [apfs, keybags, encryption]
---

APFS is designed with encryption in mind and removes the need for the [Core Storage layer](https://en.wikipedia.org/wiki/Core_Storage) used to provide encryption in HFS+. When you enable encryption on a volume, the entire [_File System Tree_](/post/2022/12/15/APFS-FSTrees) and the contents of files within that volume are encrypted. The type of encryption depends on the capabilities of the hardware that it is running on. For example, hardware encryption is used for internal storage on devices that support it, such as macOS computers with T2, M1, or M2 security chips and all iOS devices. Software encryption is used for external and internal storage devices without hardware encryption support. When hardware encryption is used, the data cannot be decrypted on any other device.  For our purposes, we will focus on the software encryption mechanisms used in macOS.  The hardware encryption functions similarly, but the security chip must broker all decryption operations.

## Encryption Keys

In macOS, APFS uses a single _Volume Encryption Key_ (`VEK`) to access encrypted content on a volume.  This `VEK` is stored on disk wrapped in several layers of encryption that allow any authorized user on the system to access the volume's contents.  In addition, several recovery keys can be used to access the `VEK`.

The `VEK` is stored encrypted on disk by a _Key Encryption Key_ (`KEK`).  Multiple copies of the `KEK` are stored on disk, each encrypted (wrapped) with a different key to allow indirect access to the VEK by various users on a system.  The keys that are used to encrypt the `KEK` can be derived from the following:

-	Each user's password
-	The drive's _Personal Recovery Key_
-	An organization's _Institutional Recovery Key_
-	Each user's _iCloud Recovery Key_

These wrapped keys are stored securely on disk in encrypted objects known as _Keybags_.

## Keybags

Once decrypted, a _Keybag_ is stored as a `media_keybag_t` structure on disk.

```cpp
// A keybag object
typedef struct media_keybag {
    obj_phys_t mk_obj;     // 0x00
    kb_locker_t mk_locker; // 0x20
} media_keybag_t;
```
- `mk_obj`: The object's header
- `mk_locker`: The keybag data 

The main component of a Keybag is a `kb_locker_t` structure.

```cpp
#define APFS_KEYBAG_VERSION 2

// A keybag
typedef struct kb_locker {
    uint16_t kl_version;         // 0x00
    uint16_t kl_nkeys;           // 0x02
    uint32_t kl_nbytes;          // 0x04
    uint8_t padding[8];          // 0x08
    keybag_entry_t kl_entries[]; // 0x10
} kb_locker_t;
```
- `kl_version`: The keybag's version (currently always 2)
- `kl_nkeys`: Number of entries stored in the keybag
- `kl_nbytes`: The size (in bytes) of the data stored in the `kl_entries` field
- `padding`: _reserved_
- `kl_entries`: The start of the entries

Immediately following the `kb_locker_t` structure is a `keybag_entry_t` structure for the first entry in the Keybag.  After this structure is the data for the entry, followed by the structure for the next entry.

```cpp
// An entry in a keybag
typedef struct keybag_entry {
    uuid_t ke_uuid;       // 0x00
    uint16_t ke_tag;      // 0x10
    uint16_t ke_keylen;   // 0x12
    uint8_t padding[4];   // 0x14
    uint8_t ke_keydata[]; // 0x18
} keybag_entry_t;
```
- `ke_uuid`: A context-specific UUID that identifies the entry
- `ke_tag`: A description of the kind of data stored in this keybag entry
- `ke_keylen`: The length (in bytes) of the keybag entry's data
- `padding`: _reserved_
- `ke_keydata`: `ke_keylen` bytes of entry data

#### Keybag Tags

{: style="margin-left: 0"}
Name | Value | Description
-----|-------|------------
KB_TAG_UNKNOWN | 0 | _reserved_ (never found on disk)
KB_TAG_RESERVED_1 | 1 | _reserved_
KB_TAG_VOLUME_KEY | 2 | The key data stores a wrapped VEK
KB_TAG_VOLUME_UNLOCK_RECORDS | 3 | In a container's keybag, the key data stores the location of the volumeʼs keybag; in a volume keybag, the key data stores a wrapped KEK.
KB_TAG_VOLUME_PASSPHRASE_HINT | 4 | The key data stores a user's password hint as plain text
KB_TAG_WRAPPING_M_KEY | 5 | The key data stores a key that's used to wrap a media key
KB_TAG_VOLUME_M_KEY | 6 | The key data stores a key that's used to wrap volume media keys
KB_TAG_RESERVED_F8 | 0xF | _reserved_


### Container Keybags

The `nx_keylocker` field of the container's [_NX Superblock_](/post/2022/12/06/APFS-NX-Superblock) is used to locate the encrypted blocks on disk that store the _Container Keybag_.  The [XTS-AES-128](https://en.wikipedia.org/wiki/Disk_encryption_theory#XEX-based_tweaked-codebook_mode_with_ciphertext_stealing_(XTS)) encryption key is a 256-bit key, derived from the container's UUID.  Read the 128-bit UUID from the `nx_uuid` field of the _NX Superblock_ and concatenate it with itself.

```python
container_keybag_key = container_uuid + container_uuid
```

Once decrypted, the container keybag stores the location of each encrypted volume's keybag as well as the wrapped `VEK` for each.

#### Volume Unlock Records

_Volume Unlock Records_ are stored in the Container Keybag with a `ke_tag` value of `KB_TAG_VOLUME_UNLOCK_RECORDS`.  The `ke_uuid` field stores the same UUID as the `apfs_vol_uuid` field of the [_Volume Superblock_](/post/2022/12/13/APFS-Volume-Superblock).  The `ke_keydata` is a `prange_t` structure that gives the location of the encrypted blocks for the volume's keybag.

#### Wrapped VEK

The wrapped `VEK` of a volume is stored in the Container Keybag with a `ke_tag` value of `KB_TAG_VOLUME_KEY` with the `ke_uuid` also being the same as the volume's UUID.  This VEK must be unwrapped using the _Key Encryption Key_.


### Volume Keybags

Each encrypted volume has its own keybag that stores the wrapped `KEKs` needed to access the `VEK`.  For software encrypted APFS, these keybags are encrypted in the same fashion as the container keybags, using two copies of the volume's UUID as a 256-bit XTS-AES-128 encryption key.  Volume keybags can also store human-readable hints to remind users of their passphrases.

#### Volume Unlock Records

In the context of Volume Keybags, Volume Unlock Records store [DER encoded](https://en.wikipedia.org/wiki/X.690#DER_encoding) information about wrapped `KEKs`.  The `ke_tag` value is always `KB_TAG_VOLUME_UNLOCK_RECORDS` and the `ke_uuid` is either a cryptographic user's UUID or a hardcoded value to denote a recovery key.  We will discuss more about the wrapped keys that are found in the `ke_keydata` field in tomorrow's post.

**Recovery Key UUIDs**

{: style="margin-left: 0"}
Name | UUID
-----|-----
INSTITUTIONAL_RECOVERY_UUID | {C064EBC6-0000-11AA-AA11-00306543ECAC}
INSTITUTIONAL_USER_UUID | {2FA31400-BAFF-4DE7-AE2A-C3AA6E1FD340} 
PERSONAL_RECOVERY_UUID | {EBC6C064-0000-11AA-AA11-00306543ECAC}
ICLOUD_RECOVERY_UUID | {64C0C6EB-0000-11AA-AA11-00306543ECAC}
ICLOUD_USER_UUID | {EC1C2AD9-B618-4ED6-BD8D-50F361C27507}

#### Passphrase Hints

_Passphrase Hint Records_ are stored with the `ke_tag` value of `KB_TAG_VOLUME_PASSPHRASE_HINT` and a cryptographic user's UUID.  The `ke_keydata` field contains a null-terminated UTF-8 string with the user's provided passphrase hint.

## Conclusion

This post covered APFS Keybags and their on-disk structures.  In our next post, we will discuss methods of unwrapping and using the decryption keys.

