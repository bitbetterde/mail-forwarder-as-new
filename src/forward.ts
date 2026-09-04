import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import type { AddressObject, Attachment, ParsedMail } from "mailparser";
import * as nodemailer from "nodemailer";

const {
  IMAP_HOST,
  IMAP_PORT,
  IMAP_USER,
  IMAP_PASSWORD,
  SMTP_HOST,
  SMTP_PORT,
  SMTP_USER,
  SMTP_PASSWORD,
  FORWARD_TO,
  FORWARD_FROM,
  ALLOWED_SENDER_DOMAINS,
} = process.env;

const PROCESSED_FOLDER = process.env.PROCESSED_FOLDER || 'Forwarded';

const DAEMON = (process.env.DAEMON || '').toLowerCase() === 'true';
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS || 60000);

// Webhook notifications (optional). Enabled when WEBHOOK_URL is set.
const WEBHOOK_URL = process.env.WEBHOOK_URL;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;
const WEBHOOK_TIMEOUT_MS = Number(process.env.WEBHOOK_TIMEOUT_MS) || 10000;

const LOG_LEVELS = { error: 0, warn: 1, info: 2, debug: 3 } as const;
type LogLevel = keyof typeof LOG_LEVELS;

const configuredLevel = (process.env.LOG_LEVEL?.toLowerCase() ?? 'info') as LogLevel;
const currentLogLevel = LOG_LEVELS[configuredLevel] ?? LOG_LEVELS.info;

const logger = {
  error: (msg: string, ...args: any[]) => {
    if (currentLogLevel >= LOG_LEVELS.error) console.error(`[ERROR] ${msg}`, ...args);
  },
  warn: (msg: string, ...args: any[]) => {
    if (currentLogLevel >= LOG_LEVELS.warn) console.warn(`[WARN]  ${msg}`, ...args);
  },
  info: (msg: string, ...args: any[]) => {
    if (currentLogLevel >= LOG_LEVELS.info) console.log(`[INFO]  ${msg}`, ...args);
  },
  debug: (msg: string, ...args: any[]) => {
    if (currentLogLevel >= LOG_LEVELS.debug) console.log(`[DEBUG] ${msg}`, ...args);
  },
};

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function validateEnvironmentVariables() {
  const requiredVars = [
    "IMAP_HOST",
    "IMAP_PORT",
    "IMAP_USER",
    "IMAP_PASSWORD",
    "SMTP_HOST",
    "SMTP_PORT",
    "SMTP_USER",
    "SMTP_PASSWORD",
    "FORWARD_TO",
    "FORWARD_FROM",
  ];

  const missingVars = requiredVars.filter((varName) => !process.env[varName]);

  if (missingVars.length > 0) {
    logger.error("Missing required environment variables: " + missingVars.join(", "));
    process.exit(1);
  }

  logger.debug("All required environment variables are set.");

  if (ALLOWED_SENDER_DOMAINS) {
    logger.info("Domain filtering enabled. Allowed domains: " + ALLOWED_SENDER_DOMAINS);
  } else {
    logger.debug("Domain filtering disabled. All emails will be forwarded.");
  }

  if (WEBHOOK_URL) {
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(WEBHOOK_URL);
    } catch {
      logger.error(`WEBHOOK_URL is not a valid URL: ${WEBHOOK_URL}`);
      process.exit(1);
    }
    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
      logger.error(`WEBHOOK_URL must use http or https, got: ${parsedUrl.protocol}`);
      process.exit(1);
    }
    // Only log the origin: webhook URLs often carry secrets in the path
    logger.info(`Webhook notifications enabled: ${parsedUrl.origin} (timeout ${WEBHOOK_TIMEOUT_MS} ms)`);
  } else {
    logger.debug("Webhook notifications disabled (WEBHOOK_URL not set).");
  }
}

// ---------------------------------------------------------------------------
// Webhooks
// ---------------------------------------------------------------------------

interface MailInfo {
  uid: number;
  messageId?: string;
  subject?: string;
  from?: string;
  to?: string;
  date?: string;
  attachments?: number;
}

type WebhookEvent =
  | {
      event: 'forwarded';
      mail: MailInfo;
      forwardedFrom: string;
      forwardedTo: string;
      smtpMessageId?: string;
    }
  | {
      event: 'error';
      /** Where the error occurred: parse | skip | forward | flag | move | poll | reconnect | fatal | unexpected */
      stage: string;
      error: string;
      mail?: MailInfo;
    };

function addressText(addr: AddressObject | AddressObject[] | undefined): string | undefined {
  if (!addr) return undefined;
  const list = Array.isArray(addr) ? addr : [addr];
  return list.map(a => a.text).filter(Boolean).join(', ') || undefined;
}

function describeMail(uid: number, parsed?: ParsedMail): MailInfo {
  if (!parsed) return { uid };
  return {
    uid,
    messageId: parsed.messageId,
    subject: parsed.subject,
    from: addressText(parsed.from),
    to: addressText(parsed.to),
    date: parsed.date?.toISOString(),
    attachments: parsed.attachments?.length ?? 0,
  };
}

// Webhook deliveries are fire-and-forget so a slow endpoint never delays mail
// processing. Pending deliveries are tracked so they can be awaited before exit.
const pendingWebhooks = new Set<Promise<void>>();

async function deliverWebhook(event: WebhookEvent): Promise<void> {
  const body = JSON.stringify({ ...event, timestamp: new Date().toISOString() });
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'User-Agent': 'mail-forwarder-as-new',
  };
  if (WEBHOOK_SECRET) headers['Authorization'] = `Bearer ${WEBHOOK_SECRET}`;

  try {
    const res = await fetch(WEBHOOK_URL!, {
      method: 'POST',
      headers,
      body,
      signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
    });
    if (!res.ok) {
      logger.warn(`Webhook '${event.event}' rejected with HTTP ${res.status}`);
      return;
    }
    logger.debug(`Webhook '${event.event}' delivered (HTTP ${res.status})`);
  } catch (err) {
    logger.warn(`Webhook '${event.event}' failed: ${errorMessage(err)}`);
  }
}

/** Never rejects. Returns a promise that resolves once delivery was attempted. */
function notifyWebhook(event: WebhookEvent): Promise<void> {
  if (!WEBHOOK_URL) return Promise.resolve();
  const delivery: Promise<void> = deliverWebhook(event).finally(() => pendingWebhooks.delete(delivery));
  pendingWebhooks.add(delivery);
  return delivery;
}

async function flushWebhooks() {
  if (pendingWebhooks.size === 0) return;
  logger.debug(`Waiting for ${pendingWebhooks.size} pending webhook delivery(ies)...`);
  await Promise.allSettled([...pendingWebhooks]);
}

// ---------------------------------------------------------------------------
// Mail processing
// ---------------------------------------------------------------------------

function shouldForwardEmail(email: ParsedMail) {
  // If no domain filtering is configured, forward all emails
  if (!ALLOWED_SENDER_DOMAINS) {
    return true;
  }

  // Get sender email address
  const fromAddress = email.from?.value?.[0]?.address || email.from?.text || '';
  
  if (!fromAddress) {
    logger.debug("No sender address found, skipping email");
    return false;
  }

  // Extract domain from sender email
  const senderDomain = fromAddress.split('@')[1]?.toLowerCase();

  if (!senderDomain) {
    logger.warn(`Invalid sender email format: ${fromAddress}`);
    return false;
  }

  // Parse allowed domains (comma-separated, case-insensitive)
  const allowedDomains = ALLOWED_SENDER_DOMAINS
    .split(',')
    .map(domain => domain.trim().toLowerCase())
    .filter(domain => domain.length > 0);

  const isAllowed = allowedDomains.includes(senderDomain);

  if (!isAllowed) {
    logger.info(`Skipping email from ${fromAddress} — domain not in allowlist: ${allowedDomains.join(', ')}`);
  }

  return isAllowed;
}

interface MailToForward {
  subject: string;
  text: string;
  html: string | undefined;
  attachments: { filename: string | undefined; content: Buffer }[];
}

async function forwardMail(email: MailToForward) {
  const transporter = nodemailer.createTransport({
    host: SMTP_HOST!,
    port: parseInt(SMTP_PORT!, 10),
    secure: parseInt(SMTP_PORT!, 10) === 465,
    auth: {
      user: SMTP_USER!,
      pass: SMTP_PASSWORD!,
    },
  });

  const mailOptions = {
    from: FORWARD_FROM!,
    to: FORWARD_TO!,
    subject: email.subject,
    text: email.text,
    html: email.html,
    attachments: email.attachments,
  };

  try {
    const info = await transporter.sendMail(mailOptions);
    logger.info(`Forwarded email: ${email.subject}`);
    return info;
  } catch (error) {
    logger.error(`Failed to forward email: ${email.subject} — ${errorMessage(error)}`);
    throw error; // Re-throw to let the caller decide how to handle
  }
}

async function processUnseen(client: ImapFlow) {
  logger.debug("Checking for unseen messages...");

  // Ensure INBOX is open
  if (!client.mailbox || client.mailbox.path !== 'INBOX') {
    logger.debug("Opening INBOX...");
    await client.mailboxOpen('INBOX');
  }

  // Fetch all unseen at once to avoid deadlocks
  const messages = await client.fetchAll({ seen: false }, { uid: true, envelope: true, source: true });

  if (messages.length === 0) {
    logger.debug("No unseen messages to process");
    return;
  }

  logger.info(`Found ${messages.length} unseen message(s)`);

  for (const msg of messages) {
    logger.debug(`Processing message UID: ${msg.uid}`);
    let parsed: ParsedMail | undefined;
    let stage = 'parse';
    try {
      parsed = await simpleParser(msg.source as Buffer);
      logger.debug(`Parsed subject: ${parsed.subject || '(no subject)'}`);

      if (!shouldForwardEmail(parsed)) {
        stage = 'skip';
        logger.debug(`Domain filter: marking UID ${msg.uid} as seen and skipping`);
        await client.messageFlagsAdd({ uid: msg.uid }, ['\\Seen']);
        continue;
      }

      stage = 'forward';
      const info = await forwardMail({
        subject: parsed.subject || '(no subject)',
        text: parsed.text || '',
        html: parsed.html || undefined, // normalize false/null → undefined
        attachments: (parsed.attachments || []).map((a: Attachment) => ({ filename: a.filename, content: a.content })),
      });

      void notifyWebhook({
        event: 'forwarded',
        mail: describeMail(msg.uid, parsed),
        forwardedFrom: FORWARD_FROM!,
        forwardedTo: FORWARD_TO!,
        smtpMessageId: info.messageId,
      });

      // Mark as seen immediately so a failed move doesn't cause re-processing
      stage = 'flag';
      await client.messageFlagsAdd({ uid: msg.uid }, ['\\Seen'], { uid: true });

      stage = 'move';
      logger.debug(`Moving UID ${msg.uid} to ${PROCESSED_FOLDER}...`);
      await client.messageMove({ uid: msg.uid }, PROCESSED_FOLDER, { uid: true });
    } catch (err) {
      logger.error(`Processing failed for UID ${msg.uid} (stage: ${stage}): ${err}`);
      void notifyWebhook({
        event: 'error',
        stage,
        error: errorMessage(err),
        mail: describeMail(msg.uid, parsed),
      });
      // Leave message untouched for retry
    }
  }
}

function createClient() {
  return new ImapFlow({
    host: IMAP_HOST!,
    port: parseInt(IMAP_PORT!, 10),
    secure: true,
    auth: { user: IMAP_USER!, pass: IMAP_PASSWORD! },
    logger: false,
  });
}

async function connectClient(client: ImapFlow) {
  logger.debug("Connecting to IMAP server...");
  await client.connect();
  logger.info("Connected to IMAP server");

  logger.debug("Opening INBOX...");
  await client.mailboxOpen('INBOX');

  // Ensure processed folder exists
  const existing = await client.list();
  if (!existing.some(m => m.path === PROCESSED_FOLDER)) {
    logger.info(`Creating folder: ${PROCESSED_FOLDER}`);
    await client.mailboxCreate(PROCESSED_FOLDER);
  }
}

async function main() {
  logger.info("Starting mail forwarder...");

  validateEnvironmentVariables();

  let client = createClient();

  try {
    await connectClient(client);
    await processUnseen(client);

    if (DAEMON) {
      logger.info(`Daemon mode: polling every ${POLL_INTERVAL_MS} ms`);
      let busy = false;
      let timer: ReturnType<typeof setInterval> | undefined;

      const shutdown = async (code = 0) => {
        logger.info("Shutting down...");
        if (timer) clearInterval(timer);
        try { await client.logout(); } catch {}
        await flushWebhooks();
        process.exit(code);
      };

      const poll = async () => {
        if (busy) {
          logger.debug("Previous poll still running, skipping");
          return;
        }
        busy = true;
        try {
          await processUnseen(client);
        } catch (e) {
          logger.error(`Polling error: ${e}`);
          void notifyWebhook({ event: 'error', stage: 'poll', error: errorMessage(e) });
          logger.info("Reconnecting to IMAP server...");
          try { await client.logout(); } catch {}
          client = createClient();
          try {
            await connectClient(client);
            logger.info("Reconnected successfully");
          } catch (reconnectError) {
            logger.error(`Reconnect failed: ${reconnectError}`);
            await notifyWebhook({ event: 'error', stage: 'reconnect', error: errorMessage(reconnectError) });
            await shutdown(1);
          }
        } finally {
          busy = false;
        }
      };

      timer = setInterval(poll, POLL_INTERVAL_MS);

      process.on('SIGTERM', () => shutdown(0));
      process.on('SIGINT', () => shutdown(0));

      logger.info("Daemon running. Press Ctrl+C to stop.");
      await new Promise(() => {}); // Keep process alive
    } else {
      await client.logout();
      await flushWebhooks();
      process.exit(0);
    }
  } catch (error) {
    logger.error(`Fatal error: ${error}`);
    await notifyWebhook({ event: 'error', stage: 'fatal', error: errorMessage(error) });
    try { await client.logout(); } catch {}
    await flushWebhooks();
    process.exit(1);
  }
}

main().catch(async err => {
  logger.error(`Unexpected error: ${err}`);
  await notifyWebhook({ event: 'error', stage: 'unexpected', error: errorMessage(err) });
  process.exit(1);
});
