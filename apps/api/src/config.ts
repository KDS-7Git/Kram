import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';

function secret(name:string) { const file=process.env[`${name}_FILE`]; return file ? readFileSync(file,'utf8').trim() : process.env[name]; }
const production=process.env.NODE_ENV==='production';
const schema=z.object({databaseUrl:z.string().min(1),sessionSecret:z.string().min(32),encryptionKey:z.string().min(32),port:z.coerce.number().int().min(1).max(65535),host:z.string(),appUrl:z.url(),trustProxy:z.string(),cookieSecure:z.boolean(),logLevel:z.enum(['fatal','error','warn','info','debug','trace','silent']),production:z.boolean()});
const developmentSecret=()=>randomBytes(32).toString('hex');
export const config=schema.parse({databaseUrl:secret('DATABASE_URL')??'postgresql://kram:change-me@127.0.0.1:5432/kram',sessionSecret:secret('SESSION_SECRET')||(production?undefined:developmentSecret()),encryptionKey:secret('ENCRYPTION_KEY')||(production?undefined:developmentSecret()),port:process.env.PORT??8420,host:process.env.HOST??'127.0.0.1',appUrl:process.env.APP_URL??'http://localhost:8420',trustProxy:process.env.TRUST_PROXY??'0',cookieSecure:process.env.COOKIE_SECURE==='true'||(production&&process.env.COOKIE_SECURE!=='false'),logLevel:process.env.LOG_LEVEL??'info',production});
process.env.DATABASE_URL=config.databaseUrl;
