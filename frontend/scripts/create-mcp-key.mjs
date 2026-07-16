import { createHash, randomBytes } from 'node:crypto';

const rawKey = `nd_mcp_${randomBytes(32).toString('base64url')}`;
const keyHash = createHash('sha256').update(rawKey, 'utf8').digest('hex');

console.log(JSON.stringify({
	rawKey,
	keyHash,
	keyPrefix: rawKey.slice(0, 15),
}, null, 2));
