# Codex

## Creating the first admin

The hosted instance keeps new accounts behind an approval gate, so the first
account has to be made from the command line. With the stack running, create
it like this:

```
docker compose exec -it app node scripts/seed-admin.ts you@example.com "Your Name"
```

You will be asked for a password, which is not shown as you type. This account
is ready to sign in straight away and can approve everyone who signs up after.

You only need to do this once. If an admin already exists, the command stops
and asks you to manage further admins from inside the app.
