# Mail Forwarder

A Node.js application that automatically forwards emails from one email account to another using IMAP and SMTP protocols.

## Features

- ✅ Monitors an IMAP mailbox for new unread emails
- ✅ Forwards emails via SMTP with full content preservation (text, HTML, attachments) but replaces the "from" header
- ✅ Deletes successfully forwarded emails from the source mailbox

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

Create a `.env` file in the project root with the following variables:

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

## Usage

Run the mail forwarder:

```bash
npm start
```

Or run directly with Node.js:

```bash
node src/forward.ts
```
