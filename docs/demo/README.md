# Try the hosted demo

A step-by-step walkthrough of the judging instance at
https://enclave.jace0423.com, using the three synthetic documents in
[`samples/`](samples/). Every document is synthetic and says so inside; none holds real data.

**Credentials are not in this repository.** The site sign-in and the role tokens are given
to the judges privately. A public repository must not carry them: anyone holding them could
use the instance and its Token Factory budget.

| File | Use |
| --- | --- |
| `samples/Q3-2026-Board-Financial-Summary.pdf` | The main delivery in the walkthrough |
| `samples/Vendor-Payment-List.csv` | A delivery nobody collects, so follow-up has something to decide |
| `samples/Merger-Term-Sheet.pdf` | A spare document for your own tries |

## Two roles, two kits

The demo has two roles and they are kept apart. You will have a **manager kit** (a sender token and the sample documents) and
an **employee kit** (a recipient token). The shared judge sign-in is needed **only for the manager's pages** (sender, audit,
administration). An employee who receives a file needs just their own token: open the link or the inbox, choose the token file,
and download. Use a computer for the manager and, ideally, a phone for the employee.

## Walkthrough

### A. The manager sends (computer)

1. Open https://enclave.jace0423.com and sign in with the judge username and password you were given.
2. **Sender page (`/`).** Press **Choose token file** and pick the manager-sender token: a green `IDENTITY VERIFIED · Sender`
   badge appears. Press **Choose document** and pick a sample; it is encrypted in the browser.
3. The approved recipients load by themselves. Tick `sales-a` and leave `sales-b` unticked, then press
   **Confirm 1: Lock draft** and **Confirm 2: Approve delivery**.
4. Under *Package result* the page shows **Recipient link (send this to the employee)**. Copy it, or skip this step: the employee
   will also find the delivery in their inbox without it.

### B. The employee receives (phone)

5. On a phone, open the recipient link (or open `/decode.html`). Press **Choose token file** and pick the sales-a token: a green
   `IDENTITY VERIFIED · Recipient` badge appears. No judge sign-in is asked for.
6. **My inbox** lists what was approved for this person: the sending department, a state and the expiry, never the file name or
   anyone else. Press **Download** on the waiting item: `ACCESS APPROVED`, the file decrypts in the phone's browser and is
   saved. Press **Confirm complete receipt**; the inbox row moves to *Earlier deliveries*.
7. **A colleague who was not picked.** Choose the sales-b token instead: the inbox shows nothing waiting. Opening the same link
   and pressing **Download original file** (under *I have a task code*) shows `ACCESS DENIED`: signed in, but not on this
   delivery.

### C. The manager checks (computer)

8. **Audit page (`/audit.html`).** Choose the manager-sender token to see this task's events, including the sales-b refusal as
   a DENY with no name on it. Under **Evidence chain**, choose the delivery and press **Show evidence**: what was approved, the
   private mapping, exactly what the model was given and answered, and whom fixed code reached.
9. **Follow-up (optional).** Send `Vendor-Payment-List.csv` to sales-a, open **Delivery options** and set *Delivery deadline
   minutes* to `1`, and do not collect it. Within about a minute the audit page shows follow-up decisions (WAIT, REMIND or
   ESCALATE) from Nemotron on Token Factory, and the evidence chain shows the five anonymous fields it was given.

The administration page (`/admin.html`) is for the owner only: the admin token is not in the judge package.

### What this hosted demo does not show

- **Two people with the same name.** The local build tells them apart by Chinese name and employee number and locks a sender after
  three failed matches; the hosted directory has no Chinese names, so that finder is not shown here. It is in the video and in the
  tests (`scripts/recipient-resolve-route.test.mjs`).
- **Revoking a delivery from the page.** The sender page has no revoke button; revocation is an API call
  (`POST /api/packages/<id>/revoke`) and a revoked delivery shows as *Revoked by the sender* in the inbox.
- **Real notices.** Email and webhook notices are dry-run records; nothing is sent, so the manager passes the link on.
- **End-to-end encryption.** The server holds the document key and releases it to an approved recipient; use synthetic files only.

Model advice comes from NVIDIA Nemotron 3 Super on Nebius Token Factory. A USD 20 spending cap
protects the key; once it is spent, advice falls back to a labelled synthetic fixture and every
other step keeps working (`/api/health`, field `nebiusBudget`). Please upload synthetic or
non-sensitive files only.
