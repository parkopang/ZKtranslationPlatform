// Local test environment only. Preserve the official model URL, Host, TLS SNI
// and certificate validation while using the configured proxy/DNS address.
import {ProxyAgent,Pool} from 'undici';
import {isIP} from 'node:net';
if(process.env.SIMULATION_ENV!=='true')throw new Error('Local network adapter requires explicit test environment');
const origin=process.env.SIMULATION_MODEL_ORIGIN || 'https://provider.example.invalid';
const serverName=process.env.SIMULATION_MODEL_SERVER_NAME || new URL(origin).hostname;
const address=process.env.SIMULATION_MODEL_ADDRESS;
const proxy=process.env.SIMULATION_MODEL_PROXY;
if(!proxy || !address || isIP(address)!==4){
  // A direct test is valid when the endpoint is reachable from Docker; do not
  // require a legacy provider IP just to start the local simulation.
} else {
  const agent=new ProxyAgent({
    uri:proxy,
    requestTls:{servername:serverName,rejectUnauthorized:true},
    clientFactory(requestOrigin,options){
      const pool=new Pool(requestOrigin,options);
      const connect=pool.connect.bind(pool);
      pool.connect=(opts,callback)=>{
        if(opts.path!==`${serverName}:443`)throw new Error('Unexpected model proxy destination');
        return connect({...opts,path:address+':443'},callback);
      };
      return pool;
    }
  });
  const originalFetch=globalThis.fetch;
  globalThis.fetch=(input,init)=>{
    const url=new URL(typeof input==='string'||input instanceof URL?input:input.url);
    if(url.origin===origin)return originalFetch(input,{...init,dispatcher:agent});
    return originalFetch(input,init);
  };
}
