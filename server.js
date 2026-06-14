#!/usr/bin/env node
// Orlix local server — serves static files + proxies bankr.bot API (no npm install needed)
const http  = require('http');
const https = require('https');
const fs    = require('fs');
const path  = require('path');

const PORT = 3001;
const BANKR_HOST = 'api.bankr.bot';

const MIME = {
  '.html':'text/html','.css':'text/css','.js':'application/javascript',
  '.json':'application/json','.png':'image/png','.jpg':'image/jpeg',
  '.svg':'image/svg+xml','.ico':'image/x-icon','.woff2':'font/woff2',
};

function cors(res){
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type,x-api-key,Authorization');
}

const server = http.createServer((req, res) => {
  cors(res);

  if(req.method==='OPTIONS'){ res.writeHead(204); res.end(); return; }

  // ── API proxy ──
  if(req.method==='POST' && req.url==='/api/chat'){
    let body='';
    req.on('data', c => body+=c);
    req.on('end', ()=>{
      const apiKey = req.headers['x-api-key']||'';
      const opt = {
        hostname: BANKR_HOST, port:443, path:'/v1/messages', method:'POST',
        headers:{'Content-Type':'application/json','x-api-key':apiKey,'Content-Length':Buffer.byteLength(body)},
      };
      const pr = https.request(opt, upRes=>{
        let data='';
        upRes.on('data',c=>data+=c);
        upRes.on('end',()=>{
          res.writeHead(upRes.statusCode,{'Content-Type':'application/json'});
          res.end(data);
        });
      });
      pr.on('error',e=>{
        res.writeHead(502,{'Content-Type':'application/json'});
        res.end(JSON.stringify({error:{message:'Proxy error: '+e.message}}));
      });
      pr.write(body); pr.end();
    });
    return;
  }

  // ── Static file server ──
  let fp = path.join(__dirname, req.url==='/'?'index.html':req.url);
  // safety: keep inside project dir
  if(!fp.startsWith(__dirname)){ res.writeHead(403);res.end();return; }

  fs.readFile(fp,(err,data)=>{
    if(err){
      // try adding .html
      fs.readFile(fp+'.html',(e2,d2)=>{
        if(e2){ res.writeHead(err.code==='ENOENT'?404:500); res.end('Not found'); return; }
        res.writeHead(200,{'Content-Type':'text/html'}); res.end(d2);
      });
      return;
    }
    const ext=path.extname(fp);
    res.writeHead(200,{'Content-Type':MIME[ext]||'application/octet-stream'});
    res.end(data);
  });
});

server.listen(PORT,()=>{
  console.log('\n  ┌─────────────────────────────────────────┐');
  console.log('  │  orlix local server running              │');
  console.log('  ├─────────────────────────────────────────┤');
  console.log(`  │  Home      →  http://localhost:${PORT}      │`);
  console.log(`  │  Dashboard →  http://localhost:${PORT}/app  │`);
  console.log('  │  Ctrl+C to stop                         │');
  console.log('  └─────────────────────────────────────────┘\n');
});
