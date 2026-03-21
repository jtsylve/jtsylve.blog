---
layout: page
title: "APFS Internals"
permalink: /apfs/
---

A deep dive into the Apple File System, published as part of the
[2022 APFS Advent Challenge](/post/2022/11/27/APFS-Advent-Challenge-2022).
18 parts covering on-disk structures, B-Trees, encryption, and more.

{% assign series = site.posts | where: "series", "APFS Internals"
   | sort: "series_part" %}

<div class="series-sections">

<div class="series-section">
<h2>Foundations</h2>
<ol class="series-list">
{% for post in series %}{% if post.series_part >= 1 and post.series_part <= 2 %}
<li><a href="{{ post.url }}">{{ post.title | remove: "2022 APFS Advent Challenge " }}</a><span class="series-list-excerpt">{{ post.excerpt | strip_html | truncatewords: 15 }}</span></li>
{% endif %}{% endfor %}
</ol>
</div>

<div class="series-section">
<h2>Container Layer</h2>
<ol class="series-list" start="3">
{% for post in series %}{% if post.series_part >= 3 and post.series_part <= 5 %}
<li><a href="{{ post.url }}">{{ post.title | remove: "2022 APFS Advent Challenge " }}</a><span class="series-list-excerpt">{{ post.excerpt | strip_html | truncatewords: 15 }}</span></li>
{% endif %}{% endfor %}
</ol>
</div>

<div class="series-section">
<h2>B-Trees and Indexing</h2>
<ol class="series-list" start="6">
{% for post in series %}{% if post.series_part >= 6 and post.series_part <= 8 %}
<li><a href="{{ post.url }}">{{ post.title | remove: "2022 APFS Advent Challenge " }}</a><span class="series-list-excerpt">{{ post.excerpt | strip_html | truncatewords: 15 }}</span></li>
{% endif %}{% endfor %}
</ol>
</div>

<div class="series-section">
<h2>Volume Layer</h2>
<ol class="series-list" start="9">
{% for post in series %}{% if post.series_part >= 9 and post.series_part <= 12 %}
<li><a href="{{ post.url }}">{{ post.title | remove: "2022 APFS Advent Challenge " }}</a><span class="series-list-excerpt">{{ post.excerpt | strip_html | truncatewords: 15 }}</span></li>
{% endif %}{% endfor %}
</ol>
</div>

<div class="series-section">
<h2>Integrity and Encryption</h2>
<ol class="series-list" start="13">
{% for post in series %}{% if post.series_part >= 13 and post.series_part <= 16 %}
<li><a href="{{ post.url }}">{{ post.title | remove: "2022 APFS Advent Challenge " }}</a><span class="series-list-excerpt">{{ post.excerpt | strip_html | truncatewords: 15 }}</span></li>
{% endif %}{% endfor %}
</ol>
</div>

<div class="series-section">
<h2>Advanced Topics</h2>
<ol class="series-list" start="17">
{% for post in series %}{% if post.series_part >= 17 and post.series_part <= 18 %}
<li><a href="{{ post.url }}">{{ post.title | remove: "2022 APFS Advent Challenge " }}</a><span class="series-list-excerpt">{{ post.excerpt | strip_html | truncatewords: 15 }}</span></li>
{% endif %}{% endfor %}
</ol>
</div>

</div>
