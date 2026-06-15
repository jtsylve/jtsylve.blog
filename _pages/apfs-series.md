---
layout: page
title: "APFS Internals"
permalink: /apfs/
---

A deep dive into the Apple File System. The series began as the
[2022 APFS Advent Challenge](/post/2022/11/27/APFS-Advent-Challenge-2022) and has
since grown into a 27-part reference covering the container layer, B-Trees, the
volume and file-system layer, integrity and encryption, and APFS's advanced
features. The original posts have been [revised and kept up to
date](/post/2026/06/01/Revisiting-the-APFS-Series) rather than left as 2022
snapshots. The on-disk structures documented throughout are current as of macOS
27 Beta (`apfs-3277.0.0.0.1`).

{% assign outline = site.data.series | where: "name", "APFS Internals" | first %}
{% assign published = site.posts | where: "series", "APFS Internals" %}

<div class="series-sections">
{% for section in outline.sections %}
<div class="series-section">
<h2>{{ section.title }}</h2>
<ol class="series-list" start="{{ section.parts[0].part }}">
{% for item in section.parts %}{% assign post = published | where: "series_part", item.part | first %}
{% if post %}
<li><a href="{{ post.url }}">{{ post.title | remove: "2022 APFS Advent Challenge " }}</a><span class="series-list-excerpt">{{ post.excerpt | strip_html | truncatewords: 15 }}</span></li>
{% else %}
<li class="coming-soon"><span class="series-item-title">{{ item.title }}</span> <span class="series-badge">Coming Soon</span></li>
{% endif %}
{% endfor %}
</ol>
</div>
{% endfor %}
</div>
