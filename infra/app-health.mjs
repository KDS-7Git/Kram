const port = process.env.PORT || '8420';
const response = await fetch(`http://127.0.0.1:${port}/api/v1/health`, { signal: AbortSignal.timeout(4000) });
if (!response.ok) process.exit(1);
const body = await response.json();
if (body.status && !['ok', 'healthy'].includes(body.status)) process.exit(1);
