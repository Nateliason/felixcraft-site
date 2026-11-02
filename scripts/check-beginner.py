from pathlib import Path
from html.parser import HTMLParser
import re,html
root=Path(__file__).resolve().parents[1]
s=(root/'index.html').read_text()
assert '[HUMAN INPUT NEEDED]' not in s,'Unresolved editorial placeholder'
assert '[implementation-facts' not in s and '[openai-starting-instructions]' not in s,'Internal evidence markers'
for key in ['email','notes','research']:
 block=re.search(r'<article data-exercise-pane="'+key+r'".*?</article>',s,re.S).group(0)
 assert (' hidden' in block.split('>')[0])==(key!='email')
 sample=html.unescape(re.search(r'<div class="sample">.*?<p>(.*?)</p>',block,re.S)[1])
 prompt=html.unescape(re.search(r'<textarea readonly id="prompt-'+key+r'"[^>]*>(.*?)</textarea>',block,re.S)[1])
 assert sample in prompt,(key,'Copy must include complete sample')
 assert 'name=' not in block and '<form' not in block and '<input' not in block
 assert f'<button disabled data-exercise="{key}"' in s
 assert f'data-copy="{key}"' in block
 assert '<button disabled class="button copy-exercise"' in block
 assert '<details class="example">' in block
 assert 'role="status"' in block
assert '[data-exercise-pane][hidden]{display:block}' in s,'No-JS full exercise fallback'
js=(root/'assets/exercises.js').read_text()
for forbidden in ['fetch(', 'XMLHttpRequest', 'localStorage','sessionStorage','sendBeacon']:
 assert forbidden not in js,forbidden
assert 'navigator.clipboard.writeText(field.value)' in js
assert "if (version !== revision || attempt !== request) return" in js
print('PASS beginner source checks: complete fictional samples, disabled controls, no named user input/API/storage, illustrative details, no placeholders, no-JS fallback')
