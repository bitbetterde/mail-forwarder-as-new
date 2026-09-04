# Mail Forwarder (as New)

A Node.js application that automatically forwards emails from one email account to another using IMAP and SMTP protocols (as a new mail). This allows us to forward emails to a single mail address, which is whitelisted at an external provider. This way, we can just forward mails to a common address instead of adding the whitelisted address to every client.

## Features

- ✅ Monitors an IMAP mailbox for new unread emails
- ✅ Forwards emails via SMTP with full content preservation (text, HTML, attachments) but replaces the "from" header
- ✅ Marks forwarded emails as read and moves them to a separate folder (default: `Forwarded`) instead of deleting them
- ✅ Optional allowlist of sender domains; emails from other domains are marked as read and skipped
- ✅ Runs once or as a daemon that polls the mailbox on an interval and reconnects on errors
- ✅ Optional webhook notifications for every forwarded mail and every error
- ✅ Ships as a Docker image

## Prerequisites

- Node.js (version 22 or higher)
- Access to both source and destination email accounts
- IMAP and SMTP server credentials

## Installation

1. Clone or download this repository
2. Install dependencies:
   ```bash
   npm install
   ```
3. Copy the environment configuration:
   ```bash
   cp .env.example .env
   ```
4. Configure your email settings in `.env`

## Configuration

Create a `.env` file in the project root. The following variables are required:

```properties
# Source IMAP Settings (where emails are received)
IMAP_HOST=your-imap-server.com
IMAP_PORT=993
IMAP_USER=source@example.com
IMAP_PASSWORD=your-password

# Destination SMTP Settings (where emails are forwarded)
SMTP_HOST=your-smtp-server.com
SMTP_PORT=465
SMTP_USER=source@example.com
SMTP_PASSWORD=your-password

# Forwarding Configuration
FORWARD_TO=destination@example.com
FORWARD_FROM=source@example.com
```

IMAP always uses TLS. SMTP uses implicit TLS on port 465; on other ports it upgrades via STARTTLS when the server offers it.

### Optional settings

| Variable                 | Default     | Description                                                                                                   |
| ------------------------ | ----------- | ------------------------------------------------------------------------------------------------------------- |
| `ALLOWED_SENDER_DOMAINS` | _(unset)_   | Comma-separated list of sender domains to forward, e.g. `example.com,trusted.org`. Unset forwards everything. |
| `PROCESSED_FOLDER`       | `Forwarded` | IMAP folder that forwarded emails are moved to. Created on startup if it does not exist.                      |
| `DAEMON`                 | `false`     | Set to `true` to keep running and poll the mailbox instead of exiting after one pass.                         |
| `POLL_INTERVAL_MS`       | `60000`     | Polling interval in daemon mode, in milliseconds.                                                              |
| `LOG_LEVEL`              | `info`      | One of `error`, `warn`, `info`, `debug`.                                                                       |
| `WEBHOOK_URL`            | _(unset)_   | Endpoint that receives a JSON `POST` for every forwarded mail and every error. See below.                     |
| `WEBHOOK_SECRET`         | _(unset)_   | Sent as `Authorization: Bearer <secret>` with every webhook request.                                          |
| `WEBHOOK_TIMEOUT_MS`     | `10000`     | Timeout for a single webhook request, in milliseconds.                                                        |

## Usage

Run the mail forwarder once. It processes all unread emails in the inbox and exits:

```bash
npm start
```

Or run directly with Node.js:

```bash
node --experimental-strip-types --env-file=.env src/forward.ts
```

To keep it running, set `DAEMON=true`. The forwarder then polls the inbox every `POLL_INTERVAL_MS`, reconnects to the IMAP server if a poll fails, and exits with a non-zero code if the reconnect fails as well, so a supervisor such as Docker can restart it. Stop it with `Ctrl+C` or `SIGTERM`.

Emails that fail to process are left unread so they are retried on the next run.

## Docker

A multi-arch image is published to GitHub Container Registry on every push to `main`:

```bash
docker run --env-file .env.docker ghcr.io/bitbetterde/mail-forwarder-as-new:latest
```

Use the same variables as above in `.env.docker`. To build and run the image locally:

```bash
npm run docker:build
npm run docker:run
```

## Webhook Notifications

Set `WEBHOOK_URL` to receive a `POST` request with a JSON body whenever a mail has been forwarded or an error occurred. Webhook calls never block or fail mail processing: a failed delivery is logged as a warning and not retried. Pending deliveries are awaited before the process exits.

Every request carries `Content-Type: application/json` and, if `WEBHOOK_SECRET` is set, `Authorization: Bearer <secret>`.

### `forwarded`

Sent after the mail was accepted by the SMTP server.

```json
{
  "event": "forwarded",
  "mail": {
    "uid": 42,
    "messageId": "<abc@example.com>",
    "subject": "Invoice 2026-09",
    "from": "Alice <alice@example.com>",
    "to": "source@example.com",
    "date": "2026-09-04T10:15:00.000Z",
    "attachments": 1
  },
  "forwardedFrom": "source@example.com",
  "forwardedTo": "destination@example.com",
  "smtpMessageId": "<def@source.example.com>",
  "timestamp": "2026-09-04T10:15:03.000Z"
}
```

### `error`

Sent whenever something goes wrong. The `mail` object is only present for errors tied to a specific message and may contain just the `uid` if the message could not be parsed.

```json
{
  "event": "error",
  "stage": "forward",
  "error": "Invalid login: 535 Authentication failed",
  "mail": {
    "uid": 42,
    "subject": "Invoice 2026-09",
    "from": "Alice <alice@example.com>"
  },
  "timestamp": "2026-09-04T10:15:03.000Z"
}
```

| `stage`      | Meaning                                                         |
| ------------ | --------------------------------------------------------------- |
| `parse`      | The raw message could not be parsed                             |
| `skip`       | Marking a filtered-out message as seen failed                   |
| `forward`    | Sending via SMTP failed                                         |
| `flag`       | Marking the forwarded message as seen failed                    |
| `move`       | Moving the forwarded message to the processed folder failed     |
| `poll`       | A poll cycle failed in daemon mode; a reconnect is attempted    |
| `reconnect`  | Reconnecting to IMAP failed; the process exits                  |
| `fatal`      | Initial connection or processing failed; the process exits      |
| `unexpected` | Any other unhandled error; the process exits                    |
