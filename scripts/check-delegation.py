from pathlib import Path
from html.parser import HTMLParser
import re,html
p=Path(__file__).resolve().parents[1];s=(p/'index.html').read_text()
h1=html.unescape(re.sub('<[^>]+>',' ',re.search(r'<h1>(.*?)</h1>',s,re.S)[1]));h1=' '.join(h1.split())
assert h1=='Finally get AI to do your work for you.',h1
assert '[HUMAN INPUT NEEDED]' not in s
assert '[verified-product-scope]' not in s and '[user-positioning]' not in s
assert 'data-exercise-pane' not in s,'Practice panels must not become the main offer again'
assert 'href="/practice.html"' in s
for anchor in ['workflows','approach','tools','guide','first-task']:assert f'id="{anchor}"' in s,anchor
for route in ['research-brief','content-repurposing','weekly-review']:assert f'href="/workflows/{route}.html"' in s
practice=(p/'practice.html').read_text()
assert '<link rel="canonical" href="https://felixcraft.ai/practice.html">' in practice
assert 'data-exercise-pane="email"' in practice
assert 'noindex,nofollow' in practice and 'noindex,nofollow' in s
print('PASS delegation source checks: exact user hero, resource routes, secondary practice, preserved anchors and indexing guards')
