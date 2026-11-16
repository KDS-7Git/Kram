# Security and privacy

Kram is designed for one owner per installation. Use HTTPS over a private VPN or an authenticated proxy/tunnel; keep PostgreSQL and the worker unexposed. Each installation has its own account and data.

Keep `.env`, `secrets/`, database volumes, backups, encryption identities and channel credentials out of source control. Production uses Docker secret files. Give channels and object-storage uploads only the permissions they need. Backups are encrypted before leaving the machine; retain the decryption identity independently of the server.

Progress history and notification attempts are permanent records. The repository must never log passwords, session cookies, CSRF tokens, channel keys or sensitive lock-screen text. Optional external channels and integrations are disabled until configured. ntfy runs with deny-by-default access.

Report suspected vulnerabilities through this repository's private reporting form: **Security → Report a vulnerability**. Include the affected version, a minimal reproduction using disposable data, and the expected security boundary. Keep credentials, personal data, and exploitable deployment details out of public issues.

Review deployment configuration and verify recovery on a clean machine before relying on an installation.
