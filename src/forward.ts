import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
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

const DAEMON = (process.env.DAEMON || '').toLowerCase() === 'true';
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS || 60000);

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
    console.error(
      "Missing required environment variables:",
      missingVars.join(", ")
    );
    process.exit(1);
  }

  console.log("All required environment variables are set.");
  
  // Log domain filtering configuration
  if (ALLOWED_SENDER_DOMAINS) {
    console.log("Domain filtering enabled. Allowed domains:", ALLOWED_SENDER_DOMAINS);
  } else {
    console.log("Domain filtering disabled. All emails will be forwarded.");
  }
}

// Custom logger for ImapFlow using console statements
const customLogger = {
  trace: () => {}, // Suppress trace logs
  debug: () => {}, // Suppress debug logs
  info: (msg: any, ...args: any[]) => {
    // Only log important info messages
    if (typeof msg === 'string' && (msg.includes('Connected') || msg.includes('Authenticated'))) {
      console.log('IMAP:', msg, ...args);
    }
  },
  warn: (msg: any, ...args: any[]) => {
    console.warn('IMAP Warning:', msg, ...args);
  },
  error: (msg: any, ...args: any[]) => {
    console.error('IMAP Error:', msg, ...args);
  },
  fatal: (msg: any, ...args: any[]) => {
    console.error('IMAP Fatal:', msg, ...args);
  }
};

function shouldForwardEmail(email) {
  // If no domain filtering is configured, forward all emails
  if (!ALLOWED_SENDER_DOMAINS) {
    return true;
  }

  // Get sender email address
  const fromAddress = email.from?.value?.[0]?.address || email.from?.text || '';
  
  if (!fromAddress) {
    console.log("No sender address found, skipping email");
    return false;
  }

  // Extract domain from sender email
  const senderDomain = fromAddress.split('@')[1]?.toLowerCase();
  
  if (!senderDomain) {
    console.log("Invalid sender email format:", fromAddress);
    return false;
  }

  // Parse allowed domains (comma-separated, case-insensitive)
  const allowedDomains = ALLOWED_SENDER_DOMAINS
    .split(',')
    .map(domain => domain.trim().toLowerCase())
    .filter(domain => domain.length > 0);

  const isAllowed = allowedDomains.includes(senderDomain);
  
  if (!isAllowed) {
    console.log(`Email from ${fromAddress} (domain: ${senderDomain}) not in allowed domains: ${allowedDomains.join(', ')}`);
  }

  return isAllowed;
}

async function forwardMail(email) {
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
    await transporter.sendMail(mailOptions);
    console.log("Forwarded email:", email.subject);
  } catch (error) {
    console.error("Failed to forward email:", email.subject, "Error:", error.message);
    throw error; // Re-throw to let the caller decide how to handle
  }
}

async function processUnseen(client: ImapFlow) {
  console.log("Starting to process unseen messages...");
  
  // Ensure INBOX is open
  if (!client.mailbox || client.mailbox.path !== 'INBOX') {
    console.log("Opening INBOX...");
    await client.mailboxOpen('INBOX');
  }

  console.log("Searching for unseen messages...");
  // Fetch all unseen at once to avoid deadlocks
  const messages = await client.fetchAll({ seen: false }, { uid: true, envelope: true, source: true });
  
  console.log(`Found ${messages.length} unseen messages`);

  if (messages.length === 0) {
    console.log("No unseen messages to process");
    return;
  }

  for (const msg of messages) {
    console.log(`Processing message UID: ${msg.uid}`);
    try {
      const parsed = await simpleParser(msg.source as Buffer);
      console.log(`Parsed email with subject: ${parsed.subject || '(no subject)'}`);

      if (!shouldForwardEmail(parsed)) {
        console.log("Skipping email due to domain filter. Marking as seen...");
        await client.messageFlagsAdd({ uid: msg.uid }, ['\\Seen']);
        console.log("Email marked as seen successfully");
        continue;
      }

      console.log("Email passed domain filter, forwarding...");
      await forwardMail({
        subject: parsed.subject || '(no subject)',
        text: parsed.text || '',
        html: parsed.html || undefined,
        attachments: (parsed.attachments || []).map(a => ({ filename: a.filename, content: a.content })),
      });

      console.log("Deleting email after successful forward...");
      // Delete only after successful forward
      await client.messageDelete({ uid: msg.uid });
      console.log("Email deleted successfully");
    } catch (err) {
      console.error('Processing failed for UID', msg.uid, err);
      // Leave message untouched for retry
    }
  }
  
  console.log("Finished processing all unseen messages");
}

async function main() {
  console.log("Starting mail forwarder application...");
  
  // Validate all required environment variables are set
  validateEnvironmentVariables();

  console.log("Creating IMAP client...");
  const client = new ImapFlow({
    host: IMAP_HOST!,
    port: parseInt(IMAP_PORT!, 10),
    secure: true,
    auth: { user: IMAP_USER!, pass: IMAP_PASSWORD! },
    logger: false // Disable ImapFlow logging completely
  });

  try {
    console.log("Connecting to IMAP server...");
    await client.connect();
    console.log("Connected successfully");
    
    console.log("Opening INBOX...");
    await client.mailboxOpen('INBOX');
    console.log("INBOX opened successfully");

    // Initial batch
    console.log("Starting initial message processing...");
    await processUnseen(client);
    console.log("Initial processing complete");

    if (DAEMON) {
      console.log(`Daemon mode enabled. Polling every ${POLL_INTERVAL_MS} ms`);
      let busy = false;

      const poll = async () => {
        if (busy) {
          console.log("Previous poll still running, skipping...");
          return;
        }
        busy = true;
        console.log("Starting scheduled poll...");
        try { 
          await processUnseen(client); 
          console.log("Scheduled poll complete");
        }
        catch (e) { 
          console.error('Polling error', e); 
        }
        finally { 
          busy = false; 
        }
      };

      const timer = setInterval(poll, POLL_INTERVAL_MS);

      const shutdown = async (code = 0) => {
        console.log("Shutting down daemon...");
        clearInterval(timer);
        try { await client.logout(); } catch {}
        process.exit(code);
      };
      process.on('SIGTERM', () => shutdown(0));
      process.on('SIGINT', () => shutdown(0));

      // Keep process alive
      console.log("Daemon running. Press Ctrl+C to stop.");
      await new Promise(() => {}); // This keeps the process alive indefinitely
    } else {
      console.log("Non-daemon mode, logging out...");
      await client.logout();
      console.log("Logged out, exiting...");
      process.exit(0);
    }
  } catch (error) {
    console.error("Error in main function:", error);
    try {
      await client.logout();
    } catch (logoutError) {
      console.error("Error during logout:", logoutError);
    }
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Unexpected error in main:', err);
  process.exit(1);
});
