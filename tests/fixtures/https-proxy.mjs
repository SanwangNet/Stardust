import { createServer } from 'node:https';
import { request } from 'node:http';
import { readFileSync } from 'node:fs';
const [ip,port,key,cert]=process.argv.slice(2);
const server=createServer({key:readFileSync(key),cert:readFileSync(cert)},(req,res)=>{
  const headers={...req.headers,'x-forwarded-proto':'https','x-forwarded-host':req.headers.host,'x-forwarded-for':req.socket.remoteAddress};
  const upstream=request({host:ip,port:Number(port),localAddress:ip,path:req.url,method:req.method,headers},response=>{res.writeHead(response.statusCode,response.headers);response.pipe(res);});
  upstream.on('error',()=>{res.writeHead(502);res.end();});req.pipe(upstream);
});
server.listen(0,ip,()=>console.log(server.address().port));
