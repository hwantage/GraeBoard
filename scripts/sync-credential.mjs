import {openDatabase} from '../server/db.mjs';
import {sealToken} from '../server/sync/credentials.mjs';
const profileId=process.argv[2];
try{
 if(!profileId||!/^[a-zA-Z0-9_-]{1,80}$/.test(profileId)||process.argv.length!==3)throw new Error('Usage: npm run sync:credential -- profileId < token-file');
 const profiles=JSON.parse(process.env.GRAEBOARD_SYNC_PROFILES||'[]');if(!profiles.some(p=>p.profileId===profileId))throw new Error('Unknown installed profile');
 let token='';for await(const part of process.stdin){token+=part;if(token.length>10000)throw new Error('Credential input too long');}
 const encrypted=sealToken(token,profileId),db=openDatabase();try{db.prepare('INSERT INTO sync_credentials VALUES(?,?,?) ON CONFLICT(profile_id) DO UPDATE SET ciphertext=excluded.ciphertext,updated_at=excluded.updated_at').run(profileId,encrypted,new Date().toISOString());}finally{db.close();}
 console.log('Encrypted Git credential stored; restart the internal service to reload the credential.');
}catch(error){console.error(error.message);process.exitCode=1;}
