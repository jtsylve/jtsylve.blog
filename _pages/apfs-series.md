---
layout: page
title: "APFS Internals"
permalink: /apfs/
---

A deep dive into the Apple File System. The series began as the
[2022 APFS Advent Challenge](/post/2022/11/27/APFS-Advent-Challenge-2022) and has
since grown to 27 parts covering the container layer, B-Trees, the volume and
file-system layer, encryption, and advanced features.

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
<h2>The Container Layer</h2>
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
<h2>Container Internals</h2>
<ol class="series-list" start="9">
{% for post in series %}{% if post.series_part >= 9 and post.series_part <= 11 %}
<li><a href="{{ post.url }}">{{ post.title | remove: "2022 APFS Advent Challenge " }}</a><span class="series-list-excerpt">{{ post.excerpt | strip_html | truncatewords: 15 }}</span></li>
{% endif %}{% endfor %}
</ol>
</div>

<div class="series-section">
<h2>The Volume and File-System Layer</h2>
<ol class="series-list" start="12">
{% for post in series %}{% if post.series_part >= 12 and post.series_part <= 18 %}
<li><a href="{{ post.url }}">{{ post.title | remove: "2022 APFS Advent Challenge " }}</a><span class="series-list-excerpt">{{ post.excerpt | strip_html | truncatewords: 15 }}</span></li>
{% endif %}{% endfor %}
</ol>
</div>

<div class="series-section">
<h2>Integrity and Encryption</h2>
<ol class="series-list" start="19">
{% for post in series %}{% if post.series_part >= 19 and post.series_part <= 23 %}
<li><a href="{{ post.url }}">{{ post.title | remove: "2022 APFS Advent Challenge " }}</a><span class="series-list-excerpt">{{ post.excerpt | strip_html | truncatewords: 15 }}</span></li>
{% endif %}{% endfor %}
</ol>
</div>

<div class="series-section">
<h2>Snapshots and Advanced Features</h2>
<ol class="series-list" start="24">
{% for post in series %}{% if post.series_part >= 24 and post.series_part <= 27 %}
<li><a href="{{ post.url }}">{{ post.title | remove: "2022 APFS Advent Challenge " }}</a><span class="series-list-excerpt">{{ post.excerpt | strip_html | truncatewords: 15 }}</span></li>
{% endif %}{% endfor %}
</ol>
</div>

</div>
