---
layout: post
title: Blazingly Fast Checksums with SIMD
categories: [file-systems, apfs, hpc]
tags: [apfs, simd, checksums, performance]
---

Today's post will take on a bit of a different style than the previous posts in this series.  Among other things, I spent my day putting off writing the final APFS encryption blog post by pursuing [another one of my New Year goals](https://infosec.exchange/@jtsylve/109554998044590227).  Along the way, I wrote a Fletcher64 hashing function that can validate APFS objects at over 31 GiB/s on my 2017 iMac Pro. Rather than fighting my procrastination, I decided it would be better to share my findings. Given that my chosen learning path was directly relevant to APFS, I'm counting this as a valid APFS Advent Challenge post (and you can't stop me!).  I hope you enjoy this brief detour into the dark arts of cross-platform SIMD programming. 

## SIMD Background

I've recently become interested in learning more about [SIMD](https://en.wikipedia.org/wiki/Single_instruction,_multiple_data) programming and how to use it to make my code faster.  SIMD stands for "Single Instruction, Multiple Data." It is a technique used in computer architectures to perform the same operation on multiple data elements in parallel, using a single instruction.

Here's an example to help illustrate the concept:

Imagine that you have a list of numbers and want to add 1 to each of them. Without SIMD, you would have to write a loop that goes through each number in the list and performs an increment operation. This may be a very time-consuming process if the list is long.

On the other hand, if your computer has SIMD support, it can simultaneously perform the same operation on multiple numbers using a single instruction. This process, known as _vectorization_, can significantly speed things up, especially for long lists of numbers.  We're not limited to simple increment operations; SIMD supports many arithmetic and logical operations on most architectures.

## Speeding up Fletcher64

During my journey, I came across some prior work by James D Guilford and Vinodh Gopal describing using SIMD for the [Fast Computation of Fletcher Checksums](https://www.intel.com/content/www/us/en/developer/articles/technical/fast-computation-of-fletcher-checksums.html) in ZFS.  While ZFS uses a different variant of a Fletcher checksum than APFS, this seemed like a great first project to get my hands dirty with vectorization.

### Portability Concerns

The authors of the Intel whitepaper use hand-coded [AVX](https://en.wikipedia.org/wiki/Advanced_Vector_Extensions) assembly instructions to perform their vectorization.  OpenZFS seems to have taken the same approach.  They have independent implementations full of inline assembly for Intel's [SSE](https://github.com/openzfs/zfs/blob/303678350a7253c7bee9d6a3347ee1bcdf9cc177/module/zcommon/zfs_fletcher_sse.c), [AVX2](https://github.com/openzfs/zfs/blob/303678350a7253c7bee9d6a3347ee1bcdf9cc177/module/zcommon/zfs_fletcher_intel.c), [AVX-512](https://github.com/openzfs/zfs/blob/303678350a7253c7bee9d6a3347ee1bcdf9cc177/module/zcommon/zfs_fletcher_avx512.c), and ARM's [NEON](https://github.com/openzfs/zfs/blob/303678350a7253c7bee9d6a3347ee1bcdf9cc177/module/zcommon/zfs_fletcher_aarch64_neon.c) architectures.  Apple takes a similar approach.  The Intel version of `apfs.kext` contains SSE, AVX, and AVX2 vectorized implementations and a fallback serialized version if, for some reason, none of these instruction sets are supported. 
The `arm64` version of the KEXT uses NEON vectorization instructions.

While these approaches work and produce high-performing and optimized code, having to hand-code an implementation for each instruction set seems to defeat the purpose of writing code in a portable language like C++.  Besides, I'm a programmer, and programmers, by our very nature, are lazy.  The compiler knows what it's doing and usually can generate better-performing code than I could hand optimize, so let's find a way to let it do its job.

### C++ TS N4808 and std::experimental::simd

It turns out that the C++ standardization committee, along with many brilliant minds, has been working on this problem for years.  Document N4808, the [Working Draft, C++ Extensions for Parallelism Version 2](https://github.com/cplusplus/parallelism-ts/releases/download/N4808/post-kona-parallelism-ts.pdf), is a proposal to add (among other things) support for portable _data parallel types_ to the C++ standard library.

This technical document proposes a generalized model of the most common SIMD operations that standard library implementations can use to allow programmers to write vectorized code that can be compiled to architecture-specific instructions without requiring architecture-specific inline assembly.  That sounds like exactly what we want!  While this has not officially been added to the language, GCC's `libstdc++` and Clang's `libc++`, have at least partial implementations in their `std::experimental` namespace.  GCC support seems the most complete, so I decided to experiment with `gcc-12`.

## The Implementation

[`std::experimental::simd`](https://en.cppreference.com/w/cpp/experimental/simd/simd) allows you to define native C++ vector types whose storage capacity depends on the underlying target architecture.  For example, NEON supports 128-bit SIMD registers, holding two 64-bit or four 32-bit integers.  AVX2 supports twice the storage with 256-bit registers, and the aptly named AVX-512 supports 512-bit registers.  We can write code once, and the size of the vectors will be architecture specific.

```cpp
namespace stdx = std::experimental;

// SIMD vector of 64-bit unsigned integers
using vu64 = stdx::native_simd<uint64_t>;

// SIMD vector of 32-bit unsigned integers
using vu32 = stdx::native_simd<uint32_t>;
```

These SIMD vectors can be used almost exactly like native integer types, and once I got over the lack of documentation, I found that they were pretty easy to use.  By taking lessons from the existing vectorized implementations and making some improvements of my own, this is what I was able to come up with:

```cpp
// N, N-2, N-4, ..., 2
static const vu64 even_m{[](const auto i) { return vu32::size() - (2 * i); }};

// N-1, N-3, N-5, ..., 1
static const vu64 odd_m = even_m - 1;

static constexpr auto max32 = std::numeric_limits<uint32_t>::max();

static uint64_t fletcher64_simd(std::span<const uint32_t, 1024> words) {
  vu64 sum1{};
  sum1[0] = -(static_cast<uint64_t>(words[0]) + words[1]);

  vu64 sum2{};
  sum2[0] = words[1];

  for (size_t n = 0; n < words.size(); n += vu32::size()) {
    sum2 += vu32::size() * sum1;

    const vu64 all{reinterpret_cast<const uint64_t*>(std::addressof(words[n])),
                   stdx::vector_aligned};

    const vu64 evens = all & max32;
    const vu64 odds = all >> 32;

    sum1 += evens + odds;
    sum2 += evens * even_m + odds * odd_m;
  }

  // Fold the 64-bit overflow back into the 32-bit value
  const auto fold = [&](uint64_t x) {
    x = (x & max32) + (x >> 32);
    return (x == max32) ? 0 : x;
  };

  const uint64_t low = fold(stdx::reduce(sum1));
  const uint64_t high = fold(stdx::reduce(sum2));

  const uint64_t ck_low = max32 - ((low + high) % max32);
  const uint64_t ck_high = max32 - ((low + ck_low) % max32);

  return ck_low | ck_high << 32;
}
```

#### Results

Below are the speed comparisons between the above SIMD function and the following serialized implementation (non-threaded, single core performance).  The times reported are the average time per checksum calculation of a 4KiB APFS object.

```cpp
static uint64_t fletcher64_serial(std::span<const uint32_t, 1024> words) {
  uint64_t sum1 = -(static_cast<uint64_t>(words[0]) + words[1]);
  uint64_t sum2 = words[1];

  for (const uint32_t word : words) {
    sum1 += word;
    sum2 += sum1;
  }

  sum1 %= max32;
  sum2 %= max32;

  const uint64_t ck_low = max32 - ((sum1 + sum2) % max32);
  const uint64_t ck_high = max32 - ((sum1 + ck_low) % max32);

  static constexpr size_t high_shift = 32;
  return ck_low | ck_high << high_shift;
}
```

My 2017 iMac Pro supports enabling 128-bit SSE, 256-bit AVX2, and 512-bit AVX-512, so it's a great candidate to show the speedups that can be achieved via vectorization.

{: style="margin-left: 0"}
Target Architecture | Time per Checksum | Throughput | Speedup
--------------------|------------|------------|--------
Serialized | 730ns | 5.21734 GiB/s | -
SSE | 509ns | 7.49126 GiB/s | 1.4x
AVX2 | 292ns | 13.0277 GiB/s | 2.5x
AVX-512 | 122ns | 31.1448 GiB/s | 6x


The relative performance of my 2021 M1 Max MacBook Pro is somewhat less impressive due to the ARM NEON architecture being limited to only 128-bit vector registers.  This computer is still very fast, and I love it.

{: style="margin-left: 0"}
Target Architecture | Time per Checksum | Throughput | Speedup
--------------------|------------|------------|--------
Serialized | 458ns | 8.31391 GiB/s | -
NEON | 368ns | 10.3417 GiB/s | 1.2x

## Conclusion

For the proper application, SIMD vectorization can provide fantastic performance benefits.  In my testing, I demonstrated a 6x speedup and hashed APFS objects at over 31 GiB/s on an iMac Pro from 2017!  The proposed SIMD additions to the C++ standard library are easy to use and generate high-performing, portable code.   I absolutely will be using this whenever I can.

### Update (December 24, 2022)

I [further improved](/post/2022/12/24/Blazingly-Fast-er-SIMD-Checksums) this code's performance to achieve even better performance!

