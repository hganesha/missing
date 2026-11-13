"""Fetch official reference pointers for availability / metadata only.
Not a verification of capabilities, API contracts, ownership or bank adoption.
"""
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor,as_completed
import requests,json,re,datetime
from bs4 import BeautifulSoup
P=Path(__file__).resolve().parents[1]
rows=json.loads((P/'catalog/providers.json').read_text())
def get(url):
 try:
  r=requests.get(url,timeout=(3,6),headers={'User-Agent':'Mozilla/5.0 (public research; no authentication)'},stream=True)
  raw=next(r.iter_content(150000),b'');r.close()
  soup=BeautifulSoup(raw,'html.parser');title=soup.title.get_text(' ',strip=True) if soup.title else ''
  m=soup.find('meta',attrs={'name':re.compile('^description$',re.I)})
  description=m.get('content','') if m else ''
  return {'url':url,'retrieval_date':'2026-10-15','http_status':r.status_code,'final_url':r.url,'title':title[:300],'description':description[:1000],'verification_scope':'HTTP response and metadata only; not capability or API verification'}
 except Exception as e:return {'url':url,'retrieval_date':'2026-10-15','http_status':None,'error':type(e).__name__,'verification_scope':'reference retrieval failed; not proof that provider unavailable'}
urls=sorted(set(r['reference_url'] for r in rows));results=[]
with ThreadPoolExecutor(max_workers=32) as ex:
 for f in as_completed([ex.submit(get,u) for u in urls]):results.append(f.result())
results.sort(key=lambda r:r['url']);(P/'research/reference-retrieval.json').write_text(json.dumps(results,indent=2,ensure_ascii=False)+'\n')
print('Pointers attempted:',len(results));print('HTTP 2xx:',sum(200<=r.get('http_status',0)<300 for r in results if r.get('http_status')))
for r in results:
 if r.get('description'):print(r['url'], '|',r['title'],'|',r['description'][:180])
