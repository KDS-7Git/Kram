import { devNull } from 'node:os';
// Every fixture starts with integrations disabled, even when the owner configured real credentials.
Object.assign(process.env, { DOTENV_CONFIG_PATH: devNull, NTFY_BASE_URL: '', NTFY_TOPIC: '', NTFY_TOKEN: '', NTFY_TOKEN_FILE: '' });
