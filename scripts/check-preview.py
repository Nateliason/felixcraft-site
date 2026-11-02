from pathlib import Path
from html.parser import HTMLParser
import subprocess,json
p=Path(__file__).resolve().parents[1]
base='99aa92324c14459d17dd9d628433f240413e7b5f'
class Check(HTMLParser):
 def handle_starttag(self,tag,attrs):
  a=dict(attrs)
  if tag=='a' and a.get('href','').startswith('/'):
   q=a['href'].split('#')[0].split('?')[0]
   assert not q or q=='/dashboard' or (p/q.lstrip('/')).exists(),q
for f in [p/'index.html',p/'practice.html',*p.glob('workflows/*.html')]:
 s=f.read_text();Check().feed(s);assert s.count('<h1>')==1,f
 assert 'noindex,nofollow' in s,f
 for block in __import__('re').findall(r'<script type="application/ld\+json">(.*?)</script>',s):json.loads(block)
for f in [p/'index.html',p/'practice.html',p/'how-to-hire-an-ai.html',p/'dashboard.html',p/'crypto-claim.html',p/'168a1eb2dd92fd596ac191d4/index.html',*p.glob('workflows/*.html')]:
 s=f.read_text();assert s.count('gtag/js?id=G-M0W5XXDYX0')==1,f
 assert s.count("gtag('config', 'G-M0W5XXDYX0')")==1,f
for f in ['dashboard.html','crypto-claim.html','168a1eb2dd92fd596ac191d4/index.html']:
 assert subprocess.check_output(['git','-C',str(p),'show',base+':'+f])==(p/f).read_bytes(),f
assert subprocess.check_output(['git','-C',str(p),'show',base+':index.html'])==(p/'how-to-hire-an-ai.html').read_bytes()
old=json.loads(subprocess.check_output(['git','-C',str(p),'show',base+':vercel.json']));new=json.loads((p/'vercel.json').read_text())
for k in ['functions','crons','redirects','rewrites']:assert old[k]==new[k]
assert {'key':'X-Robots-Tag','value':'noindex, nofollow'} in new['headers'][-1]['headers']
print('PASS: local links, GA exactly once, H1/schema, preview noindex, unchanged legacy HTML and backend config')

s=(p/'index.html').read_text()
assert not __import__('re').search(r'name="(?:task|audience|constraints)"',s),'Private input must not enter native form submission'
assert 'type="submit" disabled' in s,'Builder must fail closed before client initialization'
