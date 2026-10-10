# Receiving a file: a one-page guide for recipients

For the person who has been sent a file. You do not create an account, choose a password or ask for another permission.

## What you need

1. **The link** the sender gave you. It opens the *Recipient Decode Gate* with the task code already filled in.
2. **Your own token file** (`<your-id>.token`), issued to you in advance by your administrator. It is yours alone: do not share it, and do not use someone else's.

The sender must also have approved you for this delivery. A link and a token that are not on the sender's approved list are refused.

## Three steps (phone or computer, any current browser)

1. **Open the page** with the link you were given, or go to `/decode.html` if you were only told a file is coming. No other sign-in is asked for.
2. **Press "Choose token file"** and pick your token. A green `IDENTITY VERIFIED · Recipient` badge means the system recognised you.
   Under **My inbox** you now see what was approved for you: who it is from, its state and when it expires.
3. **Press "Download"** on the waiting item. If you were approved, the page shows `ACCESS APPROVED`, the file is decrypted in your
   browser and saved to your device. Then press **"Confirm complete receipt"** so the sender can see it arrived.

If you arrived by a link, the task code is already filled in under *I have a task code*; press **Download original file** there.
Finished, revoked and expired deliveries are kept under *Earlier deliveries*.

Nothing readable leaves your browser: the file is decrypted on your device with a key released only to you.

## What you may see instead

| Screen | Meaning | What to do |
| --- | --- | --- |
| `ACCESS DENIED` | You are signed in but are not on this delivery's approved list, or the delivery was revoked or has expired | Ask the sender. Do not try other tokens |
| Asked to sign in before the page opens | You opened a sender, audit or administration page. The receiving page never asks for the shared demo sign-in | Open the receiving page (`/decode.html`) instead |
| Token not recognised | Wrong or expired token | Ask your administrator for yours |

## Good to know

- A delivery has an expiry and a limit on how many times it can be opened. After either, it cannot be opened.
- The system does not send a message for you. In this build the email and webhook notices are dry-run records, so the sender may pass the link on (a message, a mail); you can also find the delivery in your inbox without it.
- Use a link only from someone you expect. If you did not expect a file, do not open it.
- Try it safely with the synthetic files in [`samples/`](samples/) and the walkthrough in [README.md](README.md).
