/** Desktop 0.2.2 forwards dsh-app requests with the Host cookie, but removes Origin.
 * The marker is NOT authority: only the Host Connection's authenticated owner is.
 * Browser requests continue to require the exact HTTP Origin.
 */
export function authenticatedDesktopRequest(req,connection){
  if(req.headers.origin!==undefined||req.headers['sec-fetch-site']!==undefined||req.headers['x-plcdev-desktop']!=='1')return false;
  try{const admission=connection?.admit(req);return admission?.peer?.principal?.kind==='owner'&&admission.peer.signal?.aborted!==true;}catch{return false;}
}
