# Try the hosted demo

A step-by-step walkthrough of the judging instance at
https://zero-trust-edge-enclave.zeabur.app, using the three synthetic documents in
[`samples/`](samples/). Every document is synthetic and says so inside; none holds real data.

**Credentials are not in this repository.** The site sign-in and the role tokens are given
to the judges privately. A public repository must not carry them: anyone holding them could
use the instance and its Token Factory budget.

| File | Use |
| --- | --- |
| `samples/Q3-2026-Board-Financial-Summary.pdf` | The main delivery in the walkthrough |
| `samples/Vendor-Payment-List.csv` | A delivery nobody collects, so follow-up has something to decide |
| `samples/Merger-Term-Sheet.pdf` | A spare document for your own tries |

## Walkthrough

1. **Sign in to the site** with the judge username and password you were given. This only
   opens the site; each page then asks for a role token.
2. **Sender page (`/`).** Choose the manager-sender token file — a green
   `IDENTITY VERIFIED · Sender` badge appears. Choose a sample document; it is encrypted in
   the browser. Keep the `procurement` authorization, click **Load authorized recipients**,
   pick Department `sales`, tick `sales-a` and leave `sales-b` unticked, then click
   **Confirm 1: Lock draft** and **Confirm 2: Approve delivery**.
3. **Recipient page.** Under *Package result*, open the **Recipient Decode Gate** link; the
   task code is filled in. Choose the sales-a token and click **Download original file**:
   `ACCESS APPROVED`, and the file decrypts in the browser. Click **Confirm complete receipt**.
   On the same link, choose the sales-b token and click Download: sales-b is signed in
   (`IDENTITY VERIFIED`) but was not picked for this delivery, so it shows `ACCESS DENIED`.
4. **Audit page (`/audit.html`).** Choose the manager-sender token to see this task's events,
   including the sales-b refusal as a DENY with no name on it. Under **Evidence chain**, choose
   the delivery and click **Show evidence**: what was approved, the private mapping, exactly
   what the model was given and answered, and whom fixed code reached.
5. **Follow-up (optional).** Send `Vendor-Payment-List.csv` to sales-a with
   *Delivery deadline minutes* set to `1` and do not collect it. Within about a minute the
   audit page shows follow-up decisions (WAIT, REMIND or ESCALATE) from Nemotron on Token
   Factory, and the evidence chain shows the five anonymous fields it was given.
6. **Admin page (`/admin.html`, optional).** Choose the admin token and click
   **Load directory** to see departments, people and grants.

Model advice comes from NVIDIA Nemotron 3 Super on Nebius Token Factory. A USD 20 spending cap
protects the key; once it is spent, advice falls back to a labelled synthetic fixture and every
other step keeps working (`/api/health`, field `nebiusBudget`). Please upload synthetic or
non-sensitive files only.
