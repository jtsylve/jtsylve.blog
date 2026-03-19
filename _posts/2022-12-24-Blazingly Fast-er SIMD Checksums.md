---
layout: post
title: "Update: Blazingly Fast-er SIMD Checksums"
---

This is a quick update to [yesterday's post](/post/2022/12/23/Blazingly-Fast-Checksums-with-SIMD) on using [`std::experimental::simd`](https://en.cppreference.com/w/cpp/experimental/simd/simd) to speed up APFS Fletcher-64 calculations.  It turns out that there were still some low-hanging optimizations that could be used to improve my code.  I got better performance from my code by using a simple [loop unrolling](https://en.wikipedia.org/wiki/Loop_unrolling) technique.

Here's the new version of the function.  Notice that the only difference is that I'm now calculating more data per iteration of the loop.  I'm using a lambda here to avoid code duplication, but the compiler will gladly inline the code.

```cpp
static uint64_t fletcher64_simd(std::span<const uint32_t, 1024> words) {
  vu64 sum1{};
  sum1[0] = -(static_cast<uint64_t>(words[0]) + words[1]);

  vu64 sum2{};
  sum2[0] = words[1];

  const auto calc = [&](size_t n) {
    sum2 += vu32::size() * sum1;

    const vu64 all{reinterpret_cast<const uint64_t*>(std::addressof(words[n])),
                  stdx::vector_aligned};

    const vu64 evens = all & max32;
    const vu64 odds = all >> 32;

    sum1 += evens + odds;
    sum2 += evens * even_m + odds * odd_m;
  };

  for (size_t n = 0; n < words.size(); n += vu32::size()) {
    calc(n);
    calc(n += vu32::size());
    calc(n += vu32::size());
    calc(n += vu32::size());
    calc(n += vu32::size());
    calc(n += vu32::size());
    calc(n += vu32::size());
    calc(n += vu32::size());
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

#### Updated Results

Here are the updated relative performance statistics with the updated code running on the same hardware as yesterday's tests.  Amazing!

{: style="margin-left: 0"}
Target Architecture | Time per Checksum | Throughput | Speedup
--------------------|------------|------------|--------
SSE | 217ns | 17.5543 GiB/s | 3.4x
AVX2 | 105ns | 36.2421 GiB/s | 7x
AVX-512 | 75ns | 50.7305 GiB/s | 9.7x
NEON | 171ns | 22.273 GiB/s | 2.7x