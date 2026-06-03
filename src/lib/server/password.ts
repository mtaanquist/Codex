import { hash, verify } from '@node-rs/argon2';

// argon2id with the OWASP-recommended parameters (19 MiB, 2 iterations).
const PARAMS = { memoryCost: 19456, timeCost: 2, parallelism: 1 };

export function hashPassword(password: string): Promise<string> {
	return hash(password, PARAMS);
}

export function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
	return verify(passwordHash, password).catch(() => false);
}
